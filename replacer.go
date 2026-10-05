package replacer

import "unicode/utf8"

// Segment 描述输出的一段及其在原输入中的区间（码点偏移，半开区间 [Start, End)，
// 在整个流上绝对计址）。Replaced 为 true 时 Text 是替换串，否则是原文。
type Segment struct {
	Start    int
	End      int
	Text     string
	Replaced bool
}

// Replacer 以流式方式执行词典替换。输入可按任意字节块写入（允许在
// UTF-8 序列中间切块）；内部保留足够尾部以保证与整段扫描结果一致。
// 匹配不跨越记录边界：EndRecord 冲刷尾部，之后的输入属于新记录。
// 词典仅可在记录边界通过 SetDict 切换。
type Replacer struct {
	dict *Dict

	pendingBytes []byte // 尚未凑齐一个码点的字节
	pendingRunes []rune // 已解码但未定稿的码点（尾部）
	base         int    // pendingRunes[0] 在整个流中的码点偏移

	lit      []rune // 未决字面段内容（连续未匹配码点）
	litStart int    // 未决字面段起始偏移；-1 表示无未决字面段

	segments []Segment
}

// NewReplacer 创建以 d 为初始词典的流式替换器。
func NewReplacer(d *Dict) *Replacer {
	return &Replacer{dict: d, litStart: -1}
}

// SetDict 在记录边界切换词典。若尚有未冲刷的尾部，先按旧词典以
// 记录结束方式冲刷，再启用新词典。
func (r *Replacer) SetDict(d *Dict) {
	r.EndRecord()
	r.dict = d
}

// Write 写入一块输入，返回新产生的输出段。块边界无需对齐码点。
// 紧邻尾部的字面内容可能暂缓输出，直到出现匹配或记录结束。
func (r *Replacer) Write(p []byte) []Segment {
	before := len(r.segments)
	r.pendingBytes = append(r.pendingBytes, p...)
	r.decodeBytes()
	r.process(false)
	return r.segments[before:]
}

// EndRecord 结束当前记录：把保留的尾部按“输入结束”定稿并冲刷。
// 返回新产生的输出段。
func (r *Replacer) EndRecord() []Segment {
	before := len(r.segments)
	r.process(true)
	return r.segments[before:]
}

// Segments 返回迄今产生的全部输出段。
func (r *Replacer) Segments() []Segment { return r.segments }

// Text 返回迄今产生的全部输出文本。
func (r *Replacer) Text() string {
	n := 0
	for _, s := range r.segments {
		n += len(s.Text)
	}
	b := make([]byte, 0, n)
	for _, s := range r.segments {
		b = append(b, s.Text...)
	}
	return string(b)
}

// decodeBytes 把已凑齐的码点移入 pendingRunes，尾部不完整序列留待下次。
func (r *Replacer) decodeBytes() {
	for len(r.pendingBytes) > 0 {
		c, size := utf8.DecodeRune(r.pendingBytes)
		if c == utf8.RuneError && size == 1 &&
			!utf8.FullRune(r.pendingBytes) {
			return // 序列不完整，等待更多字节
		}
		r.pendingRunes = append(r.pendingRunes, c)
		r.pendingBytes = r.pendingBytes[size:]
	}
}

// process 扫描待定稿的码点。final 为 true 时把缓冲区视为输入末尾。
// 替换段一经产生不再被扫描。
func (r *Replacer) process(final bool) {
	i := 0
	for i < len(r.pendingRunes) {
		length, e, matched, needMore := r.dict.matchAt(r.pendingRunes[i:], final)
		if needMore {
			break // 保留从 i 起的尾部，等待更多输入
		}
		if matched {
			r.flushLiteral(r.base + i)
			r.segments = append(r.segments, Segment{
				Start:    r.base + i,
				End:      r.base + i + length,
				Text:     e.Replacement,
				Replaced: true,
			})
			i += length
			continue
		}
		if r.litStart < 0 {
			r.litStart = r.base + i
		}
		r.lit = append(r.lit, r.pendingRunes[i])
		i++
	}
	if final {
		r.flushLiteral(r.base + i)
	}
	r.pendingRunes = r.pendingRunes[i:]
	r.base += i
}

// flushLiteral 把未决字面段定稿为一个输出段，end 为其结束偏移。
func (r *Replacer) flushLiteral(end int) {
	if r.litStart < 0 {
		return
	}
	r.segments = append(r.segments, Segment{
		Start: r.litStart,
		End:   end,
		Text:  string(r.lit),
	})
	r.lit, r.litStart = nil, -1
}
