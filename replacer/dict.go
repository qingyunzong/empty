// Package replacer 提供按 Unicode 码点做词典最长匹配的文本替换，
// 支持流式输入、原区间记录以及在记录边界处切换词典。
package replacer

// Entry 是词典中的一条替换规则。
type Entry struct {
	Key      string // 匹配串（按码点匹配）
	Value    string // 替换串，替换后不再被扫描
	Priority int    // 相同 Key 冲突时，取优先级高者
}

type node struct {
	children map[rune]*node
	value    string
	priority int
	terminal bool
}

// Dict 是匹配词典，内部按码点组织为 trie。
// 构建完成后可安全地并发用于扫描。
type Dict struct {
	root *node
}

// NewDict 用给定规则构建词典。
func NewDict(entries ...Entry) *Dict {
	d := &Dict{root: &node{}}
	for _, e := range entries {
		d.Add(e)
	}
	return d
}

// Add 加入一条规则。空 Key 被忽略；
// 相同 Key 已存在时，仅当新规则优先级更高才覆盖。
func (d *Dict) Add(e Entry) {
	if e.Key == "" {
		return
	}
	n := d.root
	for _, r := range e.Key {
		if n.children == nil {
			n.children = make(map[rune]*node)
		}
		next, ok := n.children[r]
		if !ok {
			next = &node{}
			n.children[r] = next
		}
		n = next
	}
	if !n.terminal || e.Priority > n.priority {
		n.terminal = true
		n.value = e.Value
		n.priority = e.Priority
	}
}

// match 在 rs 开头做最长匹配。
// 返回替换串、匹配长度（码点数，0 表示未命中）以及结果是否已确定：
// 若 decided 为 false，说明当前输入是某个更长 Key 的前缀，
// 追加输入后匹配结果可能变化，调用方应保留尾部等待更多数据。
func (d *Dict) match(rs []rune) (value string, length int, decided bool) {
	n := d.root
	best := 0
	var bestVal string
	for i, r := range rs {
		next, ok := n.children[r]
		if !ok {
			return bestVal, best, true // 失配，结果已定
		}
		n = next
		if n.terminal {
			best = i + 1
			bestVal = n.value
		}
	}
	if len(n.children) == 0 {
		return bestVal, best, true // 已是最长 Key，不可能再延长
	}
	return bestVal, best, false // 输入耗尽且可能延长，未决
}
