package mask

import "fmt"

// Streamer 支持增量块输入的脱敏器。
//
// 使用约定：
//   - Write 追加输入块（字节进入内部缓冲，不立即输出）；
//   - AddRange 以绝对偏移声明敏感范围，范围一旦声明即视为完整已知；
//   - Commit(upto) 声明 [0, upto) 内的判定已最终完成（不会再有
//     起点小于 upto 的新敏感范围），并返回当前可安全输出的脱敏字节；
//   - Finish 提交到输入末尾并返回剩余输出与完整双向位置图。
//
// 安全保证：只有同时满足「已判定」且「字节已到达」且「不被任何跨越
// 输出边界的敏感范围截断」的前缀才会被发出；未判定字段的字节一律
// 滞留在缓冲区内，不会提前泄露。
type Streamer struct {
	opts      Options
	buf       []byte  // 已接收的全部输入
	ranges    []Range // 已声明的敏感范围（未排序）
	committed int     // 已判定前缀长度
	emitted   int     // 已输出的原始字节前缀长度
	segs      []segment
	maskedLen int
	finished  bool
}

// NewStreamer 创建增量脱敏器。opts.Strategy 必须显式选择。
func NewStreamer(opts Options) *Streamer {
	return &Streamer{opts: opts}
}

// Write 追加一个输入块，返回缓冲后的总字节数。
func (s *Streamer) Write(p []byte) int {
	s.buf = append(s.buf, p...)
	return len(s.buf)
}

// AddRange 声明一个敏感范围（绝对偏移，半开区间）。
// 允许声明字节尚未到达的范围；输出会在范围完整且被提交后才产生。
func (s *Streamer) AddRange(r Range) error {
	if r.Start < 0 || r.End < r.Start {
		return fmt.Errorf("mask: invalid range [%d, %d)", r.Start, r.End)
	}
	if s.finished {
		return fmt.Errorf("mask: AddRange after Finish")
	}
	if r.Start < s.committed {
		return fmt.Errorf("mask: range [%d, %d) starts before committed offset %d", r.Start, r.End, s.committed)
	}
	if r.Start == r.End {
		return nil
	}
	s.ranges = append(s.ranges, r)
	return nil
}

// Commit 声明 [0, upto) 的判定已最终完成，返回新可输出的脱敏字节。
// upto 不得超过已接收字节数，且不得小于上次提交的偏移。
func (s *Streamer) Commit(upto int) ([]byte, error) {
	if upto < s.committed {
		return nil, errNegativeCommit
	}
	if upto > len(s.buf) {
		return nil, fmt.Errorf("mask: commit offset %d exceeds buffered %d", upto, len(s.buf))
	}
	s.committed = upto
	return s.drain(), nil
}

// drain 计算当前可安全输出的前缀并遮盖发出。
func (s *Streamer) drain() []byte {
	limit := s.committed
	if limit > len(s.buf) {
		limit = len(s.buf)
	}
	merged, _ := MergeRanges(s.ranges)
	// 若有敏感范围跨越输出边界，则回退到该范围起点，整段滞留。
	for _, r := range merged {
		if r.Start < limit && r.End > limit {
			limit = r.Start
		}
		if r.Start >= limit {
			break
		}
	}
	if limit <= s.emitted {
		return nil
	}
	var win []Range
	for _, r := range merged {
		if r.End <= s.emitted {
			continue
		}
		if r.Start >= limit {
			break
		}
		win = append(win, Range{r.Start - s.emitted, r.End - s.emitted})
	}
	out, segs := maskWindow(s.buf[s.emitted:limit], win, s.opts)
	for _, sg := range segs {
		sg.origStart += s.emitted
		sg.origEnd += s.emitted
		sg.maskStart += s.maskedLen
		sg.maskEnd += s.maskedLen
		s.segs = append(s.segs, sg)
	}
	s.maskedLen += len(out)
	s.emitted = limit
	return out
}

// Finish 提交到输入末尾，返回剩余脱敏输出与完整双向位置图。
// 之后不允许再 Write/AddRange/Commit。
func (s *Streamer) Finish() ([]byte, PosMap, error) {
	if s.finished {
		return nil, PosMap{}, fmt.Errorf("mask: Finish called twice")
	}
	s.finished = true
	s.committed = len(s.buf)
	rest := s.drain()
	pm := PosMap{segs: s.segs, origLen: len(s.buf), maskedLen: s.maskedLen}
	return rest, pm, nil
}
