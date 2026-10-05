package main

import (
	"math/rand"
	"testing"
	"time"
)

func mkProblem(n int, pairs [][2]int, setup, pp, maxCases, maxSize int) *Problem {
	return &Problem{N: n, Pairs: pairs, Setup: setup, PerPoint: pp, MaxCases: maxCases, MaxCaseSize: maxSize}
}

// TestHandComputed 手工核算的小规模最优解。
func TestHandComputed(t *testing.T) {
	cases := []struct {
		name     string
		p        *Problem
		wantCost int
		wantOK   bool
	}{
		// n=4 全部 6 对，容量 2：每用例恰好覆盖 1 对，需 6 个用例 × (10+2)。
		{"n4_k2", mkProblem(4, AllPairs(4), 10, 1, 22, 2), 72, true},
		// n=4 全部 6 对，容量 3：最优为 2 个三元组 + 1 个点对（如 012、013、23），13+13+12。
		{"n4_k3", mkProblem(4, AllPairs(4), 10, 1, 22, 3), 38, true},
		// 同上但点费用高：最优为 2 个三元组 + 1 个点对 = 31+31+21。
		{"n4_k3_expensive_points", mkProblem(4, AllPairs(4), 1, 10, 22, 3), 83, true},
		// n=5 全部 10 对，容量 3：覆盖数 C(5,2,3)=4，4×13。
		{"n5_k3", mkProblem(5, AllPairs(5), 10, 1, 22, 3), 52, true},
		// n=5 全部 10 对，容量 2 需 10 个用例，上限 3 => 不可行。
		{"infeasible_case_budget", mkProblem(5, AllPairs(5), 10, 1, 3, 2), 0, false},
		// 容量 1 无法覆盖任何双故障对 => 不可行。
		{"infeasible_capacity", mkProblem(3, AllPairs(3), 10, 1, 22, 1), 0, false},
		// 只要求单故障：容量 3 下 2 个用例（3+2 点），费用 13+12。
		{"singles_only", mkProblem(5, nil, 10, 1, 22, 3), 25, true},
		// 指定双故障对（匹配）：{0,1} 与 {2,3} 各一个用例，2×12。
		{"matching_pairs", mkProblem(4, [][2]int{{0, 1}, {2, 3}}, 10, 1, 22, 3), 24, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sol := Solve(tc.p)
			if sol.OK != tc.wantOK {
				t.Fatalf("OK=%v，期望 %v", sol.OK, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if sol.Cost != tc.wantCost {
				t.Fatalf("费用=%d，期望 %d（用例 %v）", sol.Cost, tc.wantCost, sol.Cases)
			}
			if !sol.Proven {
				t.Fatal("无时限求解应证明最优")
			}
			if len(sol.Cases) > tc.p.MaxCases {
				t.Fatalf("用例数 %d 超过上限 %d", len(sol.Cases), tc.p.MaxCases)
			}
			cost, uncovered, err := tc.p.Validate(sol.Cases)
			if err != nil || len(uncovered) > 0 {
				t.Fatalf("方案校验失败：err=%v 未覆盖=%v", err, uncovered)
			}
			if cost != sol.Cost {
				t.Fatalf("校验费用 %d 与求解费用 %d 不一致", cost, sol.Cost)
			}
		})
	}
}

// randomProblem 生成小规模随机实例（保证需求数不超出 DP 能力）。
func randomProblem(rng *rand.Rand) *Problem {
	n := 2 + rng.Intn(4) // 2..5
	all := AllPairs(n)
	var pairs [][2]int
	for _, pr := range all {
		if rng.Intn(2) == 0 {
			pairs = append(pairs, pr)
		}
	}
	return &Problem{
		N:           n,
		Pairs:       pairs,
		Setup:       rng.Intn(9), // 0..8
		PerPoint:    rng.Intn(5), // 0..4
		MaxCases:    22,
		MaxCaseSize: 1 + rng.Intn(n), // 1..n
	}
}

// TestCrossCheckDP 小规模全子集核对：分支定界结果必须与掩码 DP 全量枚举一致。
func TestCrossCheckDP(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for i := 0; i < 300; i++ {
		p := randomProblem(rng)
		sol := Solve(p)
		dpCost, dpOK, err := DPSolve(p)
		if err != nil {
			t.Fatalf("实例 %d：DP 错误：%v", i, err)
		}
		if sol.OK != dpOK {
			t.Fatalf("实例 %d（%+v）：可行性不一致 B&B=%v DP=%v", i, *p, sol.OK, dpOK)
		}
		if sol.OK && sol.Cost != dpCost {
			t.Fatalf("实例 %d（%+v）：B&B 费用 %d ≠ DP 费用 %d", i, *p, sol.Cost, dpCost)
		}
		if sol.OK {
			if _, uncovered, err := p.Validate(sol.Cases); err != nil || len(uncovered) > 0 {
				t.Fatalf("实例 %d：方案未通过覆盖校验 err=%v 未覆盖=%v", i, err, uncovered)
			}
		}
	}
}

// TestDualCertificate 下界证书必须对偶可行且不超过最优费用。
func TestDualCertificate(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 100; i++ {
		p := randomProblem(rng)
		cands := p.Candidates()
		sol := Solve(p)
		lb, y := DualLowerBound(p, cands)
		minSlack, ok := VerifyDual(p, cands, y)
		if !ok {
			t.Fatalf("实例 %d：对偶证书不可行（minSlack=%g）", i, minSlack)
		}
		if sol.OK && lb > float64(sol.Cost)+1e-6 {
			t.Fatalf("实例 %d：下界 %.6f 超过最优费用 %d", i, lb, sol.Cost)
		}
	}
}

// TestGreedyIsUpperBound 分支定界结果不劣于贪心。
func TestGreedyIsUpperBound(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for i := 0; i < 100; i++ {
		p := randomProblem(rng)
		cands := p.Candidates()
		g := Greedy(p, cands)
		s := Solve(p)
		if g.OK != s.OK {
			t.Fatalf("实例 %d：贪心可行性 %v 与精确解 %v 不一致", i, g.OK, s.OK)
		}
		if s.OK && s.Cost > g.Cost {
			t.Fatalf("实例 %d：精确解 %d 劣于贪心 %d", i, s.Cost, g.Cost)
		}
	}
}

// TestMaxCasesRespected 用例数上限必须被严格遵守。
func TestMaxCasesRespected(t *testing.T) {
	p := mkProblem(5, AllPairs(5), 10, 1, 10, 2) // 恰需 10 个用例
	sol := Solve(p)
	if !sol.OK {
		t.Fatal("应当可行")
	}
	if len(sol.Cases) != 10 {
		t.Fatalf("期望 10 个用例，得到 %d", len(sol.Cases))
	}
	p.MaxCases = 9
	if Solve(p).OK {
		t.Fatal("上限 9 时应当不可行")
	}
}

// TestTimeoutDegradesGracefully 超时时应返回可行但未证明最优的方案。
func TestTimeoutDegradesGracefully(t *testing.T) {
	p := mkProblem(6, AllPairs(6), 10, 1, 22, 3)
	sol := SolveWithTimeout(p, time.Nanosecond)
	if !sol.OK {
		t.Fatal("超时下仍应返回贪心可行解")
	}
	if sol.Proven {
		t.Fatal("1ns 时限不应来得及证明最优")
	}
	if _, uncovered, err := p.Validate(sol.Cases); err != nil || len(uncovered) > 0 {
		t.Fatalf("超时方案未通过覆盖校验 err=%v 未覆盖=%v", err, uncovered)
	}
	// 充足时限下应与精确求解一致。
	full := SolveWithTimeout(p, 10*time.Second)
	exact := Solve(p)
	if !full.Proven || full.Cost != exact.Cost {
		t.Fatalf("充足时限下费用 %d（Proven=%v）与精确解 %d 不一致", full.Cost, full.Proven, exact.Cost)
	}
}
