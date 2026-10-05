package replacer

// Piece 是输出片段。Start、End 为原始输入中的码点区间 [Start, End)；
// Replaced 为 true 表示该片段是词典命中的替换结果，
// 否则为原样透传的字面文本。
type Piece struct {
	Text     string
	Start    int
	End      int
	Replaced bool
}

type dictSeg struct {
	from int // 生效起点（码点偏移，含）
	dict *Dict
}

// Stream 是流式替换器。输入可分任意小块写入，
// 扫描位置无法确定时自动保留足够尾部，最终结果与整段扫描一致。
//
// 词典通过 SetDict 在记录边界（即两次 Write 之间）切换；
// 每个扫描位置使用其所处记录段的词典，跨越边界的匹配
// 沿用匹配起点所在段的词典。
//
// Flush 之后不应再写入；若继续 Write，偏移继续累加，
// 但匹配不会跨越 Flush 点。
type Stream struct {
	buf  []rune // 尚未确定的尾部
	base int    // buf[0] 在原始输入中的码点偏移
	segs []dictSeg

	lit     []rune // 待输出的字面尾部（可能被后续输入延长，暂不发出）
	litBase int
	hasLit  bool
}

// NewStream 创建一个流式替换器。
func NewStream() *Stream {
	return &Stream{}
}

// SetDict 从当前位置（下一段记录边界）起切换词典。
// d 为 nil 表示该段不做替换，原样透传。
func (s *Stream) SetDict(d *Dict) {
	off := s.base + len(s.buf)
	if n := len(s.segs); n > 0 && s.segs[n-1].from == off {
		s.segs[n-1].dict = d
		return
	}
	s.segs = append(s.segs, dictSeg{from: off, dict: d})
}

// Write 写入一块输入，返回本次可以确定输出的片段。
// 返回为空不代表出错，可能只是尾部尚不足以判定。
func (s *Stream) Write(str string) []Piece {
	s.buf = append(s.buf, []rune(str)...)
	return s.process(false)
}

// Flush 按输入结束处理，冲刷所有剩余缓冲并返回最终片段。
func (s *Stream) Flush() []Piece {
	return s.process(true)
}

func (s *Stream) process(flush bool) []Piece {
	var out []Piece
	i := 0
	for i < len(s.buf) {
		off := s.base + i
		d := s.dictAt(off)
		if d == nil {
			s.pushLit(s.buf[i], off)
			i++
			continue
		}
		val, n, decided := d.match(s.buf[i:])
		if !decided && !flush {
			break // 保留尾部，等待更多输入
		}
		if n > 0 {
			out = append(out, s.takeLit()...)
			out = append(out, Piece{Text: val, Start: off, End: off + n, Replaced: true})
			i += n
			continue
		}
		s.pushLit(s.buf[i], off)
		i++
	}
	s.base += i
	s.buf = s.buf[i:]
	if flush {
		out = append(out, s.takeLit()...)
	}
	return out
}

// dictAt 返回 off 位置生效的词典；未设置任何词典时返回 nil。
func (s *Stream) dictAt(off int) *Dict {
	lo, hi := 0, len(s.segs)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if s.segs[mid].from <= off {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo == 0 {
		return nil
	}
	return s.segs[lo-1].dict
}

func (s *Stream) pushLit(r rune, off int) {
	if !s.hasLit {
		s.litBase = off
		s.hasLit = true
	}
	s.lit = append(s.lit, r)
}

func (s *Stream) takeLit() []Piece {
	if !s.hasLit {
		return nil
	}
	p := Piece{Text: string(s.lit), Start: s.litBase, End: s.litBase + len(s.lit)}
	s.lit = s.lit[:0]
	s.hasLit = false
	return []Piece{p}
}
