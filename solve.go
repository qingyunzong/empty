package main

import (
	"math"
	"sort"
	"time"
)

// Solution 是一份用例方案。
type Solution struct {
	Cases  []uint64 // 每个用例的点集合掩码
	Cost   int
	OK     bool // 是否在限制内找到可行方案
	Proven bool // 是否已证明最优（超时退出时为 false，仅保证可行）
}

// Greedy 贪心构造可行解，作为分支定界的初始上界。
func Greedy(p *Problem, cands []Candidate) Solution {
	cov := newBitset(p.NumReqs())
	var cases []uint64
	cost := 0
	for cov.Count() < p.NumReqs() && len(cases) < p.MaxCases {
		bestIdx, bestGain, bestCost := -1, 0, 0
		for i := range cands {
			gain := cands[i].Cov.AndNotCount(cov)
			if gain == 0 {
				continue
			}
			// 比较 gain/cost，取比值最大者（交叉相乘避免浮点）。
			if bestIdx == -1 || gain*bestCost > bestGain*cands[i].Cost ||
				(gain*bestCost == bestGain*cands[i].Cost && cands[i].Cost < bestCost) {
				bestIdx, bestGain, bestCost = i, gain, cands[i].Cost
			}
		}
		if bestIdx == -1 {
			break // 剩余需求无任何候选可覆盖：不可行
		}
		cov.Or(cands[bestIdx].Cov)
		cases = append(cases, cands[bestIdx].Mask)
		cost += cands[bestIdx].Cost
	}
	if cov.Count() < p.NumReqs() {
		return Solution{OK: false}
	}
	return Solution{Cases: cases, Cost: cost, OK: true}
}

type solver struct {
	p           *Problem
	cands       []Candidate
	byReq       [][]int // 覆盖每个需求的候选下标（按效率降序）
	best        int
	bestCases   []uint64
	memo        map[string]int // 覆盖状态 -> 已达最小费用
	minCaseCost int
	deadline    time.Time // 零值表示无时限
	timedOut    bool
	nodes       uint64
}

// Solve 用分支定界精确求解最小费用方案（在 MaxCases 限制内），无时限。
func Solve(p *Problem) Solution {
	return SolveWithTimeout(p, 0)
}

// SolveWithTimeout 带时限的分支定界；timeout<=0 表示不限时。
// 超时返回当前最优可行解，Proven 为 false。
func SolveWithTimeout(p *Problem, timeout time.Duration) Solution {
	cands := p.Candidates()
	s := &solver{
		p:           p,
		cands:       cands,
		byReq:       make([][]int, p.NumReqs()),
		best:        math.MaxInt,
		memo:        make(map[string]int),
		minCaseCost: p.CaseCost(1),
	}
	if timeout > 0 {
		s.deadline = time.Now().Add(timeout)
	}
	for i := range cands {
		for r := 0; r < p.NumReqs(); r++ {
			if cands[i].Cov.Test(r) {
				s.byReq[r] = append(s.byReq[r], i)
			}
		}
	}
	// 存在无任何候选可覆盖的需求 => 不可行。
	for r := 0; r < p.NumReqs(); r++ {
		if len(s.byReq[r]) == 0 {
			return Solution{OK: false}
		}
	}
	// 按 覆盖需求数/费用 降序排列分支顺序。
	for r := range s.byReq {
		list := s.byReq[r]
		sort.Slice(list, func(a, b int) bool {
			ca, cb := cands[list[a]], cands[list[b]]
			return ca.Cov.Count()*cb.Cost > cb.Cov.Count()*ca.Cost
		})
	}
	if g := Greedy(p, cands); g.OK {
		s.best = g.Cost
		s.bestCases = g.Cases
	}
	s.search(newBitset(p.NumReqs()), nil, 0)
	if s.best == math.MaxInt {
		return Solution{OK: false}
	}
	return Solution{Cases: s.bestCases, Cost: s.best, OK: true, Proven: !s.timedOut}
}

// lowerBound 估计还需要的用例数与追加费用下界。
// 用例数：未覆盖需求数 / 单个候选最多能新覆盖的需求数，向上取整。
// 费用：未覆盖需求数 / 所有候选的 新增覆盖/费用 最大比值（优于按最小用例费估计）。
func (s *solver) lowerBound(cov bitset) (needCases int, minAddCost float64) {
	uncovered := s.p.NumReqs() - cov.Count()
	maxGain := 0
	bestRatio := 0.0
	for i := range s.cands {
		g := s.cands[i].Cov.AndNotCount(cov)
		if g > maxGain {
			maxGain = g
		}
		if r := float64(g) / float64(s.cands[i].Cost); r > bestRatio {
			bestRatio = r
		}
	}
	if maxGain == 0 {
		return math.MaxInt, math.Inf(1)
	}
	needCases = (uncovered + maxGain - 1) / maxGain
	minAddCost = float64(uncovered) / bestRatio
	if c := float64(needCases * s.minCaseCost); c > minAddCost {
		minAddCost = c
	}
	return needCases, minAddCost
}

func (s *solver) search(cov bitset, chosen []uint64, cost int) {
	s.nodes++
	if s.nodes&0x3FF == 0 && !s.deadline.IsZero() && time.Now().After(s.deadline) {
		s.timedOut = true
	}
	if s.timedOut {
		return
	}
	if cost >= s.best {
		return
	}
	if cov.Count() == s.p.NumReqs() {
		s.best = cost
		s.bestCases = append([]uint64(nil), chosen...)
		return
	}
	if len(chosen) >= s.p.MaxCases {
		return
	}
	need, addCost := s.lowerBound(cov)
	if len(chosen)+need > s.p.MaxCases {
		return
	}
	if float64(cost)+addCost >= float64(s.best)-1e-9 {
		return
	}
	key := cov.key()
	if v, ok := s.memo[key]; ok && v <= cost {
		return
	}
	s.memo[key] = cost
	r := cov.FirstZero(s.p.NumReqs())
	for _, ci := range s.byReq[r] {
		c := &s.cands[ci]
		next := cov.Clone()
		next.Or(c.Cov)
		s.search(next, append(chosen, c.Mask), cost+c.Cost)
	}
}
