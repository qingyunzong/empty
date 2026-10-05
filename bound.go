package main

import "math"

// 下界证书：集合覆盖 LP 松弛的对偶可行解。
//
//	原始 LP:  min  Σ_c cost(c)·x_c   s.t. 对每个需求 e: Σ_{c∋e} x_c ≥ 1, x ≥ 0
//	对偶 LP:  max  Σ_e y_e           s.t. 对每个候选 c: Σ_{e∈c} y_e ≤ cost(c), y ≥ 0
//
// 任意对偶可行解 y 都给出全问题（含整数解）的下界 Σ_e y_e。
// 这里用坐标上升构造 y，再整体收缩并精确验证，保证证书严格有效。

// DualLowerBound 返回对偶权重 y 及下界值 Σy。
// 取以下候选对偶解中的最优者：均匀权重解、多种需求顺序下的坐标上升解。
func DualLowerBound(p *Problem, cands []Candidate) (lb float64, y []float64) {
	R := p.NumReqs()
	best := make([]float64, R)
	bestLB := math.Inf(-1)
	try := func(cand []float64) {
		cand = shrinkToFeasible(p, cands, cand)
		var sum float64
		for _, v := range cand {
			sum += v
		}
		if sum > bestLB {
			bestLB, best = sum, cand
		}
	}
	try(uniformDual(p, cands))
	// 坐标上升对需求顺序敏感，用多种确定性顺序重启并保留最优。
	orders := dualOrders(R, 64)
	for _, ord := range orders {
		try(coordinateAscent(p, cands, ord))
	}
	return bestLB, best
}

// shrinkToFeasible 整体收缩对偶权重，直到严格满足全部候选约束（带相对裕量）。
// 用于消除浮点累积误差导致的潜在不可行；失败时返回全零解（总是可行）。
func shrinkToFeasible(p *Problem, cands []Candidate, y []float64) []float64 {
	R := p.NumReqs()
	for scale := 1 - 1e-9; scale > 0.5; scale -= 1e-6 {
		ok := true
		for i := range cands {
			var sum float64
			for r := 0; r < R; r++ {
				if cands[i].Cov.Test(r) {
					sum += y[r] * scale
				}
			}
			if sum > float64(cands[i].Cost)*(1-1e-9) {
				ok = false
				break
			}
		}
		if ok {
			out := make([]float64, R)
			for e := range y {
				out[e] = y[e] * scale
			}
			return out
		}
	}
	return make([]float64, R)
}

// uniformDual 均匀权重：y_e = w，w 取满足全部候选约束的最大值。
func uniformDual(p *Problem, cands []Candidate) []float64 {
	R := p.NumReqs()
	w := math.Inf(1)
	for i := range cands {
		if r := float64(cands[i].Cost) / float64(cands[i].Cov.Count()); r < w {
			w = r
		}
	}
	y := make([]float64, R)
	for e := range y {
		y[e] = w
	}
	return y
}

// dualOrders 生成多种需求处理顺序：正序、逆序、双故障优先，以及若干确定性打乱。
func dualOrders(R, shuffles int) [][]int {
	id := make([]int, R)
	for i := range id {
		id[i] = i
	}
	rev := make([]int, R)
	for i := range rev {
		rev[i] = R - 1 - i
	}
	orders := [][]int{id, rev}
	seed := uint64(0x9e3779b97f4a7c15)
	for s := 0; s < shuffles; s++ {
		ord := make([]int, R)
		copy(ord, id)
		for i := R - 1; i > 0; i-- {
			seed ^= seed << 13
			seed ^= seed >> 7
			seed ^= seed << 17
			j := int(seed % uint64(i+1))
			ord[i], ord[j] = ord[j], ord[i]
		}
		orders = append(orders, ord)
	}
	return orders
}

// coordinateAscent 按给定需求顺序做坐标上升（可行性由 shrinkToFeasible 保证）。
func coordinateAscent(p *Problem, cands []Candidate, order []int) []float64 {
	R := p.NumReqs()
	y := make([]float64, R)
	slack := make([]float64, len(cands))
	for i := range cands {
		slack[i] = float64(cands[i].Cost)
	}
	// 每个需求 -> 覆盖它的候选列表。
	byReq := make([][]int, R)
	for i := range cands {
		for r := 0; r < R; r++ {
			if cands[i].Cov.Test(r) {
				byReq[r] = append(byReq[r], i)
			}
		}
	}
	// 坐标上升：逐需求把 y_e 提升到覆盖它的候选的最小剩余容量。
	for pass := 0; pass < 200; pass++ {
		improved := false
		for _, e := range order {
			m := math.Inf(1)
			for _, ci := range byReq[e] {
				if slack[ci] < m {
					m = slack[ci]
				}
			}
			if m > 1e-12 {
				y[e] += m
				for _, ci := range byReq[e] {
					slack[ci] -= m
				}
				improved = true
			}
		}
		if !improved {
			break
		}
	}
	return y
}

// VerifyDual 严格验证对偶证书：y ≥ 0 且每个候选的权重和不超过其费用。
// 返回最小剩余容量（应 ≥ 0）。
func VerifyDual(p *Problem, cands []Candidate, y []float64) (minSlack float64, ok bool) {
	R := p.NumReqs()
	if len(y) != R {
		return 0, false
	}
	for _, v := range y {
		if v < 0 {
			return 0, false
		}
	}
	minSlack = math.Inf(1)
	for i := range cands {
		var sum float64
		for r := 0; r < R; r++ {
			if cands[i].Cov.Test(r) {
				sum += y[r]
			}
		}
		if s := float64(cands[i].Cost) - sum; s < minSlack {
			minSlack = s
		}
	}
	return minSlack, minSlack >= 0
}
