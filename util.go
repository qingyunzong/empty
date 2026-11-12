package dataeng

import (
	"fmt"
	"math"
	"slices"
)

// toStrings 将任意可比较 ID 批量转为可读字符串，用于错误汇总。
func toStrings[T any](in []T) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		out = append(out, fmt.Sprint(v))
	}
	return out
}

// sortByOrder 按插入顺序索引对 ID 切片排序，保证输出确定性。
func sortByOrder[T comparable](ids []T, order map[T]int) {
	slices.SortFunc(ids, func(a, b T) int {
		oa, ob := order[a], order[b]
		if oa < ob {
			return -1
		}
		if oa > ob {
			return 1
		}
		return 0
	})
}

// verifyExtrema 针对单个子记录核验联合覆盖的极值：
// 覆盖并集与缺口拼出的整体必须从子区间起点开始、到终点结束，
// 且缺口序列本身升序、互不相交、互不相接（已是最大区间）。
func verifyExtrema(child Interval, covered, gaps []Interval) error {
	if child.empty() {
		if len(gaps) != 0 {
			return fmt.Errorf("empty child has gaps %v", gaps)
		}
		return nil
	}
	for i, g := range gaps {
		if g.Start >= g.End {
			return fmt.Errorf("invalid gap %v", g)
		}
		if g.Start < child.Start || g.End > child.End {
			return fmt.Errorf("gap %v escapes child %v", g, child)
		}
		if i > 0 && g.Start <= gaps[i-1].End {
			return fmt.Errorf("gaps not maximal/disjoint: %v then %v", gaps[i-1], g)
		}
	}
	union := unionIntervals(append(clipIntervals(covered, child), gaps...))
	if len(union) == 0 || union[0].Start != child.Start || union[len(union)-1].End != child.End {
		return fmt.Errorf("extrema mismatch: union %v vs child %v", union, child)
	}
	if child.Start == math.MinInt64 && union[0].Start != math.MinInt64 {
		return fmt.Errorf("min int64 endpoint not covered by union %v", union)
	}
	if child.End == math.MaxInt64 && union[len(union)-1].End != math.MaxInt64 {
		return fmt.Errorf("max int64 endpoint not covered by union %v", union)
	}
	return nil
}

// extremaProbe 是一条极值核验用例：child 与 covered 下期望的缺口结果。
type extremaProbe struct {
	name    string
	child   Interval
	covered []Interval
	want    []Interval
}

// extremaProbes 覆盖 int64 极值边界、相接/重叠父区间、空区间等情形。
// 期望值同时约束扫描线与离散化两种算法，任何分歧都会被 Verify 捕获。
func extremaProbes() []extremaProbe {
	minI := int64(math.MinInt64)
	maxI := int64(math.MaxInt64)
	return []extremaProbe{
		{
			name:  "full range no parent",
			child: Interval{minI, maxI},
			want:  []Interval{{minI, maxI}},
		},
		{
			name:    "full range left parent half-open",
			child:   Interval{minI, maxI},
			covered: []Interval{{minI, 0}},
			want:    []Interval{{0, maxI}},
		},
		{
			name:    "full range right parent",
			child:   Interval{minI, maxI},
			covered: []Interval{{0, maxI}},
			want:    []Interval{{minI, 0}},
		},
		{
			name:    "full range adjacent parents",
			child:   Interval{minI, maxI},
			covered: []Interval{{minI, 100}, {100, maxI}},
			want:    nil,
		},
		{
			name:    "full range overlapping parents",
			child:   Interval{minI, maxI},
			covered: []Interval{{minI, 5}, {0, maxI}},
			want:    nil,
		},
		{
			name:  "negative half no parent",
			child: Interval{minI, 0},
			want:  []Interval{{minI, 0}},
		},
		{
			name:  "positive half no parent",
			child: Interval{0, maxI},
			want:  []Interval{{0, maxI}},
		},
		{
			name:    "tiny window near max",
			child:   Interval{maxI - 2, maxI},
			covered: []Interval{{maxI - 1, maxI}},
			want:    []Interval{{maxI - 2, maxI - 1}},
		},
		{
			name:    "empty parent interval ignored",
			child:   Interval{minI, maxI},
			covered: []Interval{{minI, minI}},
			want:    []Interval{{minI, maxI}},
		},
		{
			name:  "empty child no gap",
			child: Interval{5, 5},
			want:  nil,
		},
		{
			name:    "internal gap with extrema parents",
			child:   Interval{minI, maxI},
			covered: []Interval{{minI, -10}, {10, maxI}},
			want:    []Interval{{-10, 10}},
		},
		{
			name:    "parent exceeding child bounds",
			child:   Interval{minI + 10, maxI - 10},
			covered: []Interval{{minI, maxI}},
			want:    nil,
		},
	}
}

// verifyExtremaProbes 对全部极值探针逐一用两种算法核验，
// 并要求结果与期望完全一致（端点比较，不做中点运算，避免溢出）。
func verifyExtremaProbes() error {
	for _, p := range extremaProbes() {
		merged := unionIntervals(p.covered)
		sweep := sweepGaps(p.child, merged)
		disc := discreteGaps(p.child, p.covered)
		if !intervalsEqual(sweep, p.want) {
			return fmt.Errorf("extrema probe %q: sweep got %v want %v", p.name, sweep, p.want)
		}
		if !intervalsEqual(disc, p.want) {
			return fmt.Errorf("extrema probe %q: discrete got %v want %v", p.name, disc, p.want)
		}
	}
	return nil
}
