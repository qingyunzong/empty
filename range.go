package auditlog

import (
	"errors"
	"fmt"
	"sort"
)

// Range 为半开区间 [Start, End)，表示载荷中需要脱敏的字节范围。
type Range struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

var ErrInvalidRange = errors.New("auditlog: invalid range")

// Validate 校验范围相对给定载荷长度是否合法：
// 0 <= Start <= End <= length。空范围（Start == End）合法但为无操作。
func (r Range) Validate(length int) error {
	if r.Start < 0 || r.End < 0 || r.Start > r.End || r.End > length {
		return fmt.Errorf("%w: [%d, %d) against length %d", ErrInvalidRange, r.Start, r.End, length)
	}
	return nil
}

// MergeRanges 对范围清单排序并合并重叠或相邻的范围，
// 返回规范化后的清单（按起点升序、互不重叠、不含空范围）。
// 输入可以是任意顺序、跨批次提供的范围。
func MergeRanges(ranges []Range) []Range {
	nonEmpty := make([]Range, 0, len(ranges))
	for _, r := range ranges {
		if r.Start < r.End {
			nonEmpty = append(nonEmpty, r)
		}
	}
	if len(nonEmpty) == 0 {
		return nil
	}
	sort.Slice(nonEmpty, func(i, j int) bool {
		if nonEmpty[i].Start != nonEmpty[j].Start {
			return nonEmpty[i].Start < nonEmpty[j].Start
		}
		return nonEmpty[i].End < nonEmpty[j].End
	})
	merged := []Range{nonEmpty[0]}
	for _, r := range nonEmpty[1:] {
		last := &merged[len(merged)-1]
		if r.Start <= last.End { // 重叠或相邻，合并
			if r.End > last.End {
				last.End = r.End
			}
			continue
		}
		merged = append(merged, r)
	}
	return merged
}

// ValidateRanges 校验清单中每个范围，并返回合并后的规范清单。
func ValidateRanges(ranges []Range, length int) ([]Range, error) {
	for _, r := range ranges {
		if err := r.Validate(length); err != nil {
			return nil, err
		}
	}
	return MergeRanges(ranges), nil
}
