// Package mask 按原始字节范围对敏感字段进行脱敏。
//
// 核心语义：
//   - 敏感范围以原始输入的字节偏移 [Start, End) 表示；
//   - 重叠或相邻的范围先求并；
//   - 替换策略必须显式选择：同长替换（ModeSameLength）或摘要替换（ModeDigest）；
//   - 非敏感字节原样保留；
//   - 返回双向位置图，可在原始偏移与输出偏移之间互相换算。
package mask

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
)

// Range 表示原始输入中的一个半开字节区间 [Start, End)。
type Range struct {
	Start int
	End   int
}

// Mode 是替换策略，必须显式选择，不存在默认值。
type Mode int

const (
	modeUnset Mode = iota
	// ModeSameLength 同长替换：敏感区每个字节替换为 MaskByte，输出长度不变。
	ModeSameLength
	// ModeDigest 摘要替换：敏感区整体替换为 "[sha256:<hex>]"，输出长度改变。
	ModeDigest
)

// Options 描述一次脱敏调用的全部参数。
type Options struct {
	Mode Mode // 必填，必须显式选择
	// MaskByte 同长替换时使用的遮盖字节，为零值时使用 '*'。
	MaskByte byte
}

// ErrModeUnset 表示调用方未显式选择替换策略。
var ErrModeUnset = errors.New("mask: 必须显式选择替换策略（ModeSameLength 或 ModeDigest）")

// MergeRanges 对范围求并：重叠或相邻的范围合并为一个，结果按起始偏移升序。
// 空范围（Start >= End）被丢弃。
func MergeRanges(ranges []Range) []Range {
	clean := make([]Range, 0, len(ranges))
	for _, r := range ranges {
		if r.Start < r.End {
			clean = append(clean, r)
		}
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
	return merged
}

// ValidateRanges 校验范围在 [0, total] 内且 Start <= End。
func ValidateRanges(ranges []Range, total int) error {
	for _, r := range ranges {
		if r.Start < 0 || r.End < r.Start || r.End > total {
			return fmt.Errorf("mask: 非法范围 [%d, %d)，输入长度 %d", r.Start, r.End, total)
		}
	}
	return nil
}

// digestOf 计算摘要替换文本。
func digestOf(field []byte) []byte {
	sum := sha256.Sum256(field)
	out := make([]byte, 0, 9+64+1)
	out = append(out, "[sha256:"...)
	out = hex.AppendEncode(out, sum[:])
	out = append(out, ']')
	return out
}

// segment 是位置图的一段：原始区间 [OrigStart, OrigEnd) 对应输出区间
// [OutStart, OutEnd)。Kept 为 true 时两段等长且逐字节线性对应；
// Kept 为 false 时是脱敏段，映射钳制到段边界。
type segment struct {
	OrigStart, OrigEnd int
	OutStart, OutEnd   int
	Kept               bool
}

// PositionMap 是原始输入与脱敏输出之间的双向位置图。
type PositionMap struct {
	segs []segment
}

// OrigToOut 将原始偏移换算为输出偏移。
// 保留段内线性映射；脱敏段内（含其内部任意偏移）映射到替换文本的起始位置；
// 输入末尾之后钳制到输出末尾。
func (m PositionMap) OrigToOut(off int) int {
	if len(m.segs) == 0 {
		return 0
	}
	if off <= 0 {
		return 0
	}
	for _, s := range m.segs {
		if off < s.OrigEnd {
			if off < s.OrigStart {
				return s.OutStart
			}
			if s.Kept {
				return s.OutStart + (off - s.OrigStart)
			}
			return s.OutStart
		}
	}
	last := m.segs[len(m.segs)-1]
	return last.OutEnd
}

// OutToOrig 将输出偏移换算为原始偏移。
// 保留段内线性映射；替换文本内部映射回原始敏感段的起始偏移；
// 输出末尾之后钳制到原始输入末尾。
func (m PositionMap) OutToOrig(off int) int {
	if len(m.segs) == 0 {
		return 0
	}
	if off <= 0 {
		return 0
	}
	for _, s := range m.segs {
		if off < s.OutEnd {
			if off < s.OutStart {
				return s.OrigStart
			}
			if s.Kept {
				return s.OrigStart + (off - s.OutStart)
			}
			return s.OrigStart
		}
	}
	last := m.segs[len(m.segs)-1]
	return last.OrigEnd
}

// Mask 按给定范围对 src 脱敏，返回输出字节与双向位置图。
// 非敏感字节原样保留；重叠范围先求并。
func Mask(src []byte, ranges []Range, opts Options) ([]byte, PositionMap, error) {
	if opts.Mode != ModeSameLength && opts.Mode != ModeDigest {
		return nil, PositionMap{}, ErrModeUnset
	}
	if err := ValidateRanges(ranges, len(src)); err != nil {
		return nil, PositionMap{}, err
	}
	maskByte := opts.MaskByte
	if maskByte == 0 {
		maskByte = '*'
	}
	merged := MergeRanges(ranges)

	out := make([]byte, 0, len(src))
	segs := make([]segment, 0, 2*len(merged)+1)
	cursor := 0
	appendKept := func(from, to int) {
		if from >= to {
			return
		}
		segs = append(segs, segment{
			OrigStart: from, OrigEnd: to,
			OutStart: len(out), OutEnd: len(out) + (to - from),
			Kept: true,
		})
		out = append(out, src[from:to]...)
	}
	for _, r := range merged {
		appendKept(cursor, r.Start)
		outStart := len(out)
		switch opts.Mode {
		case ModeSameLength:
			for i := r.Start; i < r.End; i++ {
				out = append(out, maskByte)
			}
		case ModeDigest:
			out = append(out, digestOf(src[r.Start:r.End])...)
		}
		segs = append(segs, segment{
			OrigStart: r.Start, OrigEnd: r.End,
			OutStart: outStart, OutEnd: len(out),
			Kept: false,
		})
		cursor = r.End
	}
	appendKept(cursor, len(src))
	return out, PositionMap{segs: segs}, nil
}
