// Package mask 按原始字节范围对敏感字段进行脱敏遮盖。
//
// 核心能力：
//   - 敏感范围以原始字节偏移（半开区间 [Start, End)）描述；
//   - 重叠或相邻的范围在遮盖前求并；
//   - 替换策略二选一且必须显式指定：同长替换（SameLength）或摘要替换（Digest）；
//   - 非敏感字节原样保留，并产出原始偏移与脱敏后偏移的双向位置图（PosMap）；
//   - Streamer 支持增量块输入，未判定区域的字节一律暂缓输出，不会提前泄露。
package mask

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
)

// Range 是原始输入中的半开字节区间 [Start, End)。
type Range struct {
	Start int
	End   int
}

// Strategy 指定敏感字节的替换方式。
type Strategy int

const (
	// SameLength 同长替换：每个敏感字节替换为一个遮盖字节，输出长度不变。
	SameLength Strategy = iota
	// Digest 摘要替换：整段敏感字节替换为 "<sha256:hex>"，输出长度可变。
	Digest
)

// Options 遮盖选项。Strategy 必须显式给出，零值即 SameLength，
// 调用方应在 SameLength 与 Digest 之间做出明确选择。
type Options struct {
	Strategy Strategy
	// MaskByte 为 SameLength 策略使用的遮盖字节，零值时默认为 '*'。
	MaskByte byte
}

func (o Options) maskByte() byte {
	if o.MaskByte == 0 {
		return '*'
	}
	return o.MaskByte
}

// MergeRanges 对范围做校验、排序并求并（重叠或相邻的区间合并为一个）。
// 返回的区间按 Start 升序、互不重叠。空区间（Start == End）被丢弃。
func MergeRanges(rs []Range) ([]Range, error) {
	clean := make([]Range, 0, len(rs))
	for _, r := range rs {
		if r.Start < 0 || r.End < r.Start {
			return nil, fmt.Errorf("mask: invalid range [%d, %d)", r.Start, r.End)
		}
		if r.Start == r.End {
			continue
		}
		clean = append(clean, r)
	}
	sort.Slice(clean, func(i, j int) bool {
		if clean[i].Start != clean[j].Start {
			return clean[i].Start < clean[j].Start
		}
		return clean[i].End < clean[j].End
	})
	merged := make([]Range, 0, len(clean))
	for _, r := range clean {
		if n := len(merged); n > 0 && r.Start <= merged[n-1].End {
			if r.End > merged[n-1].End {
				merged[n-1].End = r.End
			}
			continue
		}
		merged = append(merged, r)
	}
	return merged, nil
}

// segment 描述一段原始字节到脱敏字节的映射。
type segment struct {
	origStart, origEnd int
	maskStart, maskEnd int
}

func (s segment) sensitive() bool {
	return s.maskEnd-s.maskStart != s.origEnd-s.origStart || s.origStart == s.origEnd
}

// PosMap 是原始偏移与脱敏偏移之间的双向位置图。
//
// 保留区段内偏移按线性关系换算；敏感区段内：
//   - ToMasked 将原始偏移映射到替换内容的起始偏移；
//   - ToOrig 将替换内容内的偏移映射回敏感区段的原始起始偏移。
type PosMap struct {
	segs      []segment
	origLen   int
	maskedLen int
}

// ToMasked 返回原始偏移 o 对应的脱敏后偏移。o 越界时夹取到边界。
func (m PosMap) ToMasked(o int) int {
	if o <= 0 {
		return 0
	}
	if o >= m.origLen {
		return m.maskedLen
	}
	for _, s := range m.segs {
		if o < s.origEnd {
			if s.sensitive() {
				return s.maskStart
			}
			return s.maskStart + (o - s.origStart)
		}
	}
	return m.maskedLen
}

// ToOrig 返回脱敏后偏移 t 对应的原始偏移。t 越界时夹取到边界。
func (m PosMap) ToOrig(t int) int {
	if t <= 0 {
		return 0
	}
	if t >= m.maskedLen {
		return m.origLen
	}
	for _, s := range m.segs {
		if t < s.maskEnd {
			if s.sensitive() {
				return s.origStart
			}
			return s.origStart + (t - s.maskStart)
		}
	}
	return m.origLen
}

// MaskedLen 返回脱敏输出的总长度。
func (m PosMap) MaskedLen() int { return m.maskedLen }

// OrigLen 返回原始输入的总长度。
func (m PosMap) OrigLen() int { return m.origLen }

// maskWindow 对 src 执行遮盖，ranges 必须已合并且全部落在 src 内。
// 返回脱敏结果与相对于 src 起点的映射段。
func maskWindow(src []byte, ranges []Range, opts Options) ([]byte, []segment) {
	out := make([]byte, 0, len(src))
	segs := make([]segment, 0, 2*len(ranges)+1)
	pos := 0
	flush := func(upto int) {
		if upto > pos {
			segs = append(segs, segment{pos, upto, len(out), len(out) + (upto - pos)})
			out = append(out, src[pos:upto]...)
		}
	}
	for _, r := range ranges {
		flush(r.Start)
		start := len(out)
		switch opts.Strategy {
		case SameLength:
			mb := opts.maskByte()
			for i := r.Start; i < r.End; i++ {
				out = append(out, mb)
			}
		case Digest:
			sum := sha256.Sum256(src[r.Start:r.End])
			out = append(out, "<sha256:"...)
			out = hex.AppendEncode(out, sum[:])
			out = append(out, '>')
		}
		segs = append(segs, segment{r.Start, r.End, start, len(out)})
		pos = r.End
	}
	flush(len(src))
	return out, segs
}

// Mask 对 src 按 ranges 遮盖敏感字段，返回脱敏结果与双向位置图。
// 重叠范围先求并；范围越界时返回错误。
func Mask(src []byte, ranges []Range, opts Options) ([]byte, PosMap, error) {
	merged, err := MergeRanges(ranges)
	if err != nil {
		return nil, PosMap{}, err
	}
	for _, r := range merged {
		if r.End > len(src) {
			return nil, PosMap{}, fmt.Errorf("mask: range [%d, %d) exceeds input length %d", r.Start, r.End, len(src))
		}
	}
	out, segs := maskWindow(src, merged, opts)
	return out, PosMap{segs: segs, origLen: len(src), maskedLen: len(out)}, nil
}

var errNegativeCommit = errors.New("mask: commit offset regressed")
