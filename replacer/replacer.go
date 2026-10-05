package replacer

import "strings"

// Replace 用词典 d 对整段文本 s 做一次扫描，返回输出片段序列。
// 片段按码点最长匹配生成，替换串不再被扫描。
func Replace(d *Dict, s string) []Piece {
	st := NewStream()
	st.SetDict(d)
	pieces := st.Write(s)
	return append(pieces, st.Flush()...)
}

// ReplaceString 是 Replace 的便捷形式，直接返回拼接后的结果串。
func ReplaceString(d *Dict, s string) string {
	return Join(Replace(d, s))
}

// Join 把片段序列拼接为结果串。
func Join(pieces []Piece) string {
	var b strings.Builder
	for _, p := range pieces {
		b.WriteString(p.Text)
	}
	return b.String()
}
