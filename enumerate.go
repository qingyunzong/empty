package main

// EnumEntry 记录一种切分在“每段取最便宜可行车型”下的结果。
type EnumEntry struct {
	Solution Solution
	Feasible bool
}

// Enumeration 是对全部 2^(n-1) 种切分的穷举结果。
type Enumeration struct {
	Total    int         // 切分总数
	Feasible int         // 存在可行车型指派的切分数
	Best     *Solution   // 最优切分（费用最小，再列数少）
	Entries  []EnumEntry // 每种切分的对照记录
}

// Enumerate 穷举所有保持原序的连续切分；每种切分内对每段独立选取
// 费用最低的可行车型（段间互不干扰，故该选取即此切分下的最优）。
func Enumerate(p *Problem) *Enumeration {
	s := newSolver(p)
	n := s.n
	total := 1 << (n - 1)
	enum := &Enumeration{Total: total, Entries: make([]EnumEntry, 0, total)}
	for mask := 0; mask < total; mask++ {
		// 切点：第 k 位为 1 表示在车厢 k 之后切开。
		cuts := []int{0}
		for k := 0; k < n-1; k++ {
			if mask&(1<<k) != 0 {
				cuts = append(cuts, k+1)
			}
		}
		cuts = append(cuts, n)

		sol := Solution{Trains: len(cuts) - 1}
		feasible := true
		for c := 0; c+1 < len(cuts); c++ {
			j, i := cuts[c], cuts[c+1]
			tk, ok := s.cheapestType(j, i)
			if !ok {
				feasible = false
				break
			}
			t := p.Types[tk]
			sol.Cost += t.Cost
			sol.Segments = append(sol.Segments, Segment{
				Start: j, End: i, Type: t,
				Length: s.segLen(j, i), Weight: s.segWt(j, i), Cost: t.Cost,
			})
		}
		enum.Entries = append(enum.Entries, EnumEntry{Solution: sol, Feasible: feasible})
		if !feasible {
			continue
		}
		enum.Feasible++
		if enum.Best == nil ||
			sol.Cost < enum.Best.Cost-eps ||
			(absf(sol.Cost-enum.Best.Cost) <= eps && sol.Trains < enum.Best.Trains) {
			best := sol
			enum.Best = &best
		}
	}
	return enum
}

func absf(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
