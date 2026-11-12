package dataeng

import (
	"slices"
)

// Interval 是 [Start, End) 形式的半开 int64 区间。
// Start == End 表示空区间；Start > End 为反向区间，必须拒绝。
type Interval struct {
	Start int64
	End   int64
}

// valid 报告半开区间是否合法：空区间（起止相等）合法，起止反向非法。
func (in Interval) valid() bool { return in.Start <= in.End }

func (in Interval) empty() bool { return in.Start == in.End }

// unionIntervals 按扫描线求区间并集：重叠与相接（半开端点相等）的区间合并，
// 输出互不相交、按起点升序的最大区间序列。
func unionIntervals(in []Interval) []Interval {
	if len(in) == 0 {
		return nil
	}
	work := make([]Interval, 0, len(in))
	for _, iv := range in {
		if !iv.empty() {
			work = append(work, iv)
		}
	}
	if len(work) == 0 {
		return nil
	}
	slices.SortFunc(work, func(a, b Interval) int {
		if a.Start != b.Start {
			if a.Start < b.Start {
				return -1
			}
			return 1
		}
		if a.End != b.End {
			if a.End < b.End {
				return -1
			}
			return 1
		}
		return 0
	})
	out := make([]Interval, 0, len(work))
	cur := work[0]
	for _, iv := range work[1:] {
		if iv.Start <= cur.End {
			if iv.End > cur.End {
				cur.End = iv.End
			}
		} else {
			out = append(out, cur)
			cur = iv
		}
	}
	out = append(out, cur)
	return out
}

// sweepGaps 用扫描线返回 child 区间内未被 covered（已合并的并集）覆盖的、
// 互不相交的最大区间，按起点升序。child 为空区间时返回 nil。
func sweepGaps(child Interval, covered []Interval) []Interval {
	if child.empty() || !child.valid() {
		return nil
	}
	gaps := make([]Interval, 0)
	cursor := child.Start
	for _, iv := range covered {
		if iv.End <= cursor {
			continue
		}
		if iv.Start >= child.End {
			break
		}
		if iv.Start > cursor {
			gaps = append(gaps, Interval{cursor, min(iv.Start, child.End)})
		}
		if iv.End > cursor {
			cursor = iv.End
		}
		if cursor >= child.End {
			break
		}
	}
	if cursor < child.End {
		gaps = append(gaps, Interval{cursor, child.End})
	}
	if len(gaps) == 0 {
		return nil
	}
	return gaps
}

// discreteGaps 以端点离散化重算 child 内未被 covered 覆盖的区间：
// 收集所有区间端点构成离散网格，逐段判定覆盖状态，再合并相邻同状态段。
// 全程只比较端点，不计算中点，因而对 int64 极值不会溢出。
func discreteGaps(child Interval, covered []Interval) []Interval {
	if child.empty() || !child.valid() {
		return nil
	}
	points := map[int64]struct{}{child.Start: {}, child.End: {}}
	for _, iv := range covered {
		if iv.empty() || !iv.valid() {
			continue
		}
		points[iv.Start] = struct{}{}
		points[iv.End] = struct{}{}
	}
	grid := make([]int64, 0, len(points))
	for p := range points {
		grid = append(grid, p)
	}
	slices.Sort(grid)

	gaps := make([]Interval, 0)
	var gapStart int64
	inGap := false
	closeGap := func(end int64) {
		if inGap && gapStart < end {
			gaps = append(gaps, Interval{gapStart, end})
		}
		inGap = false
	}
	for i := 0; i+1 < len(grid); i++ {
		lo, hi := grid[i], grid[i+1]
		if lo == hi || hi <= child.Start || lo >= child.End {
			continue
		}
		isCovered := false
		for _, iv := range covered {
			if iv.valid() && !iv.empty() && iv.Start <= lo && hi <= iv.End {
				isCovered = true
				break
			}
		}
		if isCovered {
			closeGap(lo)
			continue
		}
		if !inGap {
			inGap = true
			gapStart = lo
		}
	}
	closeGap(child.End)
	if len(gaps) == 0 {
		return nil
	}
	return gaps
}

// diffIntervals 返回 after 相对 before 的净增区间（after − before），
// 同样基于端点离散化逐段分类，输出已合并的最大区间。
func diffIntervals(after, before []Interval) []Interval {
	points := make(map[int64]struct{})
	for _, list := range [2][]Interval{after, before} {
		for _, iv := range list {
			points[iv.Start] = struct{}{}
			points[iv.End] = struct{}{}
		}
	}
	grid := make([]int64, 0, len(points))
	for p := range points {
		grid = append(grid, p)
	}
	slices.Sort(grid)

	belongs := func(list []Interval, lo, hi int64) bool {
		for _, iv := range list {
			if iv.Start <= lo && hi <= iv.End {
				return true
			}
		}
		return false
	}

	out := make([]Interval, 0)
	var segStart int64
	inDiff := false
	flush := func(end int64) {
		if inDiff && segStart < end {
			out = append(out, Interval{segStart, end})
		}
		inDiff = false
	}
	for i := 0; i+1 < len(grid); i++ {
		lo, hi := grid[i], grid[i+1]
		if lo == hi {
			continue
		}
		isNew := belongs(after, lo, hi) && !belongs(before, lo, hi)
		if isNew {
			if !inDiff {
				inDiff = true
				segStart = lo
			}
		} else {
			flush(lo)
		}
	}
	flush(grid[len(grid)-1])
	if len(out) == 0 {
		return nil
	}
	return out
}

// intervalsEqual 比较两个区间集合（顺序无关，先各自并集规范化再比较）。
func intervalsEqual(a, b []Interval) bool {
	ua := unionIntervals(a)
	ub := unionIntervals(b)
	if len(ua) != len(ub) {
		return false
	}
	for i := range ua {
		if ua[i] != ub[i] {
			return false
		}
	}
	return true
}
