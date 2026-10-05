package main

import (
	"fmt"
	"math"
)

// DPMaxReqs 限制掩码 DP 的需求数，保证状态空间可控。
const DPMaxReqs = 22

// DPSolve 用覆盖掩码 DP 做全量核对：枚举所有候选用例的 0/1 选择，
// 状态为已覆盖需求掩码，逐层记录恰好使用 k 个用例的最小费用。
// 仅适用于小规模（需求数 <= DPMaxReqs），用于独立验证分支定界结果。
func DPSolve(p *Problem) (cost int, ok bool, err error) {
	if p.NumReqs() > DPMaxReqs {
		return 0, false, fmt.Errorf("需求数 %d 超过 DP 上限 %d", p.NumReqs(), DPMaxReqs)
	}
	full := uint64(1)<<uint(p.NumReqs()) - 1
	cands := p.Candidates()
	dist := make([]map[uint64]int, p.MaxCases+1)
	for k := range dist {
		dist[k] = make(map[uint64]int)
	}
	dist[0][0] = 0
	for _, c := range cands {
		var cm uint64
		for r := 0; r < p.NumReqs(); r++ {
			if c.Cov.Test(r) {
				cm |= 1 << uint(r)
			}
		}
		for k := p.MaxCases - 1; k >= 0; k-- {
			for m, d := range dist[k] {
				nm := m | cm
				nd := d + c.Cost
				if v, seen := dist[k+1][nm]; !seen || nd < v {
					dist[k+1][nm] = nd
				}
			}
		}
	}
	best := math.MaxInt
	for k := 0; k <= p.MaxCases; k++ {
		if v, seen := dist[k][full]; seen && v < best {
			best = v
		}
	}
	if best == math.MaxInt {
		return 0, false, nil
	}
	return best, true, nil
}
