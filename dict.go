// Package replacer 提供基于词典的文本替换：按 Unicode 码点做最长匹配，
// 同长度取优先级高者，替换结果不再被扫描；支持流式输入与记录边界切换词典。
package replacer

// Entry 是一条词典条目。
type Entry struct {
	Pattern     string // 匹配串（按码点匹配，不允许为空）
	Replacement string // 替换串（输出后不再扫描）
	Priority    int    // 同长度匹配冲突时，数值大者优先
}

type trieNode struct {
	children map[rune]*trieNode
	terminal bool
	entry    Entry
}

// Dict 是不可变的替换词典，可安全并发使用。
type Dict struct {
	root   *trieNode
	maxLen int // 最长模式的码点数
}

// NewDict 由条目构建词典。相同 Pattern 重复注册时保留优先级最高者，
// 优先级相同保留先注册者。
func NewDict(entries ...Entry) *Dict {
	d := &Dict{root: &trieNode{}}
	for _, e := range entries {
		runes := []rune(e.Pattern)
		if len(runes) == 0 {
			continue
		}
		n := d.root
		for _, r := range runes {
			if n.children == nil {
				n.children = make(map[rune]*trieNode)
			}
			if n.children[r] == nil {
				n.children[r] = &trieNode{}
			}
			n = n.children[r]
		}
		if !n.terminal || e.Priority > n.entry.Priority {
			n.terminal = true
			n.entry = e
		}
		if len(runes) > d.maxLen {
			d.maxLen = len(runes)
		}
	}
	return d
}

// MaxPatternLen 返回词典中最长模式的码点数。
func (d *Dict) MaxPatternLen() int { return d.maxLen }

// matchAt 在 runes 从位置 0 起做最长匹配，返回匹配码点数与条目。
// final 为 false 且缓冲区可能在末尾被截断时，返回 matched=false 且
// needMore=true 表示“当前路径仍可延伸，需等待更多输入”。
func (d *Dict) matchAt(runes []rune, final bool) (length int, e Entry, matched, needMore bool) {
	n := d.root
	for i, r := range runes {
		next := n.children[r]
		if next == nil {
			return length, e, matched, false
		}
		n = next
		if n.terminal {
			length, e, matched = i+1, n.entry, true
		}
	}
	// 走到了缓冲区末尾且路径仍可延伸。
	if !final && len(n.children) > 0 {
		return length, e, false, true
	}
	return length, e, matched, false
}
