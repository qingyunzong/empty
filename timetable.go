// Package timetable 在循环周期内为若干条线路选择离散发车偏移，
// 使指定换乘对的等待超时罚分最小；罚分并列时取字典序最小的偏移向量。
//
// 模型约定：
//   - 周期为 Period，所有时间均对 Period 取模（循环时刻表）。
//   - 每条线路 i 的可选偏移集合为 Domains[i]，取值须在 [0, Period) 内。
//   - 换乘对 (From, To)：乘客乘 From 线，在 From 发车后 FromTravel 分钟
//     到达换乘站；To 线在发车后 ToTravel 分钟到达同一换乘站。
//   - 等待时间 = (To 到站时刻 - From 到站时刻) mod Period，取值 [0, Period)。
//   - 同刻可换乘：到达与发车同刻时等待为 0，不算超时。
//   - 等待时间 > Threshold 时计罚 Weight 分（Weight <= 0 按 1 计）。
//
// 约束规模：线路数 1..MaxLines(8)，每条线路偏移域大小 1..MaxDomain(12)。
package timetable

import (
	"errors"
	"fmt"
	"sort"
)

const (
	// MaxLines 为支持的最多线路数。
	MaxLines = 8
	// MaxDomain 为每条线路偏移域的最大取值个数。
	MaxDomain = 12
)

// Transfer 描述一个指定换乘对。所有时间量均为周期内的分钟数。
type Transfer struct {
	From       int // 出发线路下标
	To         int // 接续线路下标
	FromTravel int // From 线发车到换乘站的走行时间
	ToTravel   int // To 线发车到换乘站的走行时间
	Threshold  int // 可接受的最大等待时间（含）；超过则计罚
	Weight     int // 超时罚分权重；<= 0 时按 1 计
}

// Problem 为一次偏移选择问题。
type Problem struct {
	Period    int        // 循环周期，必须为正
	Domains   [][]int    // 每条线路的可选偏移集合
	Transfers []Transfer // 指定换乘对
}

// Validate 校验问题参数是否满足规模与取值约束。
func (p Problem) Validate() error {
	if p.Period <= 0 {
		return errors.New("timetable: period must be positive")
	}
	if len(p.Domains) == 0 || len(p.Domains) > MaxLines {
		return fmt.Errorf("timetable: need 1..%d lines, got %d", MaxLines, len(p.Domains))
	}
	for i, d := range p.Domains {
		if len(d) == 0 || len(d) > MaxDomain {
			return fmt.Errorf("timetable: line %d domain size must be 1..%d, got %d", i, MaxDomain, len(d))
		}
		for _, o := range d {
			if o < 0 || o >= p.Period {
				return fmt.Errorf("timetable: line %d offset %d outside [0,%d)", i, o, p.Period)
			}
		}
	}
	for i, t := range p.Transfers {
		if t.From < 0 || t.From >= len(p.Domains) || t.To < 0 || t.To >= len(p.Domains) {
			return fmt.Errorf("timetable: transfer %d references unknown line", i)
		}
		if t.Threshold < 0 {
			return fmt.Errorf("timetable: transfer %d has negative threshold", i)
		}
	}
	return nil
}

// WaitTime 返回循环周期内从 arrival 到 departure 的等待时间，取值 [0, period)。
// arrival == departure 时返回 0，即同刻可换乘。
func WaitTime(period, arrival, departure int) int {
	w := (departure - arrival) % period
	if w < 0 {
		w += period
	}
	return w
}

func weightOf(t Transfer) int {
	if t.Weight <= 0 {
		return 1
	}
	return t.Weight
}

func transferPenalty(period int, t Transfer, offsets []int) int {
	arr := (offsets[t.From] + t.FromTravel) % period
	dep := (offsets[t.To] + t.ToTravel) % period
	if WaitTime(period, arr, dep) > t.Threshold {
		return weightOf(t)
	}
	return 0
}

// Evaluate 计算一个完整偏移向量的总罚分。
func Evaluate(p Problem, offsets []int) (int, error) {
	if err := p.Validate(); err != nil {
		return 0, err
	}
	if len(offsets) != len(p.Domains) {
		return 0, fmt.Errorf("timetable: offset vector length %d, want %d", len(offsets), len(p.Domains))
	}
	total := 0
	for _, t := range p.Transfers {
		total += transferPenalty(p.Period, t, offsets)
	}
	return total, nil
}

// sortedDomains 返回排序去重后的偏移域，保证枚举顺序即字典序。
func sortedDomains(domains [][]int) [][]int {
	out := make([][]int, len(domains))
	for i, d := range domains {
		cp := make([]int, len(d))
		copy(cp, d)
		sort.Ints(cp)
		k := 0
		for _, v := range cp {
			if k == 0 || cp[k-1] != v {
				cp[k] = v
				k++
			}
		}
		out[i] = cp[:k]
	}
	return out
}

// Solve 求罚分最小的偏移向量；罚分并列时返回字典序最小者。
// 采用按字典序的分支限界深度优先搜索：罚分按换乘对分解，
// 部分解的累计罚分是完整解罚分的下界，可安全剪枝。
func Solve(p Problem) ([]int, int, error) {
	if err := p.Validate(); err != nil {
		return nil, 0, err
	}
	domains := sortedDomains(p.Domains)
	n := len(domains)

	// 按换乘对较晚一端的线路下标分组，便于在DFS中增量累计罚分。
	byLine := make([][]Transfer, n)
	for _, t := range p.Transfers {
		m := t.From
		if t.To > m {
			m = t.To
		}
		byLine[m] = append(byLine[m], t)
	}

	const inf = int(^uint(0) >> 1)
	best := make([]int, n)
	bestPen := inf
	cur := make([]int, n)

	var dfs func(i, pen int)
	dfs = func(i, pen int) {
		// 字典序遍历下，已有最优解的罚分不可再被追平或超越时剪枝。
		if pen >= bestPen {
			return
		}
		if i == n {
			bestPen = pen
			copy(best, cur)
			return
		}
		for _, off := range domains[i] {
			cur[i] = off
			add := 0
			for _, t := range byLine[i] {
				add += transferPenalty(p.Period, t, cur)
			}
			dfs(i+1, pen+add)
		}
	}
	dfs(0, 0)
	return best, bestPen, nil
}

// SolveBruteForce 为参考核验实现：对各路偏移域做笛卡尔积全枚举，
// 仅在罚分严格更小时更新最优解，因此并列时保留字典序最小向量。
// 结果与 Solve 完全一致，仅用于小规模核验。
func SolveBruteForce(p Problem) ([]int, int, error) {
	if err := p.Validate(); err != nil {
		return nil, 0, err
	}
	domains := sortedDomains(p.Domains)
	n := len(domains)

	const inf = int(^uint(0) >> 1)
	best := make([]int, n)
	bestPen := inf
	cur := make([]int, n)

	var rec func(i int)
	rec = func(i int) {
		if i == n {
			pen := 0
			for _, t := range p.Transfers {
				pen += transferPenalty(p.Period, t, cur)
			}
			if pen < bestPen {
				bestPen = pen
				copy(best, cur)
			}
			return
		}
		for _, off := range domains[i] {
			cur[i] = off
			rec(i + 1)
		}
	}
	rec(0)
	return best, bestPen, nil
}
