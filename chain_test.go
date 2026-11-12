package dataeng_test

import (
	"math/big"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

// buildChain 构造 n 个二元变量的链 V0-V1-...-V(n-1)，仅保留末变量。
func buildChain(n int, weighted bool) ([]dataeng.Variable, []dataeng.Factor) {
	vars := make([]dataeng.Variable, n)
	for i := 0; i < n; i++ {
		vars[i] = dataeng.Variable{ID: chainID(i), Domain: []string{"0", "1"}}
	}
	factors := make([]dataeng.Factor, 0, n)
	// 单变量先验。
	prior := dataeng.Factor{Scope: []string{chainID(0)}, Entries: []dataeng.Entry{
		{[]string{"0"}, rat(1, 1)}, {[]string{"1"}, rat(1, 1)},
	}}
	factors = append(factors, prior)
	for i := 0; i+1 < n; i++ {
		f := dataeng.Factor{Scope: []string{chainID(i), chainID(i + 1)}}
		for _, x := range []string{"0", "1"} {
			for _, y := range []string{"0", "1"} {
				val := rat(1, 1)
				if weighted && x != y {
					val = rat(int64(i+2), 1) // 非均匀、任意精度有理势
				}
				f.Entries = append(f.Entries, dataeng.Entry{[]string{x, y}, val})
			}
		}
		factors = append(factors, f)
	}
	return vars, factors
}

func chainID(i int) string {
	// 固定两位 ID 保证 ASCII 序与下标序一致。
	return "v" + string(rune('0'+i/10)) + string(rune('0'+i%10))
}

// chainForward 是与消元独立的前向消息参考：逐变量做二元表加权求和。
func chainForward(n int, weighted bool) (*big.Rat, *big.Rat) {
	// msg[value] 是从链首传到当前变量的未规范化消息。
	msg := []*big.Rat{rat(1, 1), rat(1, 1)}
	for i := 0; i+1 < n; i++ {
		next := []*big.Rat{new(big.Rat), new(big.Rat)}
		for x := 0; x < 2; x++ {
			for y := 0; y < 2; y++ {
				w := rat(1, 1)
				if weighted && x != y {
					w = rat(int64(i+2), 1)
				}
				next[y].Add(next[y], new(big.Rat).Mul(msg[x], w))
			}
		}
		msg = next
	}
	z := new(big.Rat).Add(msg[0], msg[1])
	return msg[1], z
}

func TestChain40NoWorldEnumeration(t *testing.T) {
	const n = 40
	for _, weighted := range []bool{false, true} {
		vars, factors := buildChain(n, weighted)
		model, err := dataeng.NewModel(vars, factors)
		if err != nil {
			t.Fatalf("weighted=%v: %v", weighted, err)
		}
		if model.VariableCount() != 40 {
			t.Fatalf("variable count = %d", model.VariableCount())
		}

		// 链上每轮结合表至多 4 单元，预算 4 即可完成，远小于 2^40。
		res, err := model.Query([]string{chainID(n - 1)}, nil, big.NewInt(4))
		if err != nil {
			t.Fatalf("weighted=%v: %v", weighted, err)
		}
		if res.Status != dataeng.StatusOK {
			t.Fatalf("weighted=%v: status=%s required=%s", weighted, res.Status, res.RequiredCells)
		}
		if len(res.Trace) != n-1 {
			t.Fatalf("weighted=%v: rounds=%d want %d", weighted, len(res.Trace), n-1)
		}
		for i, r := range res.Trace {
			if r.RequiredCells.Cmp(big.NewInt(4)) > 0 {
				t.Fatalf("round %d requires %s cells, chain must never exceed 4", i, r.RequiredCells)
			}
			if len(r.ResultScope) > 2 {
				t.Fatalf("round %d result scope grew beyond chain width: %v", i, r.ResultScope)
			}
			if r.Eliminated == "" || len(r.InvolvedScopes) == 0 ||
				len(r.CombinedScope) == 0 || r.RequiredCells == nil {
				t.Fatalf("round %d trace incomplete: %+v", i, r)
			}
			if r.Synthetic {
				t.Fatalf("chain variable %s must have real factors, no synthetic unary", r.Eliminated)
			}
		}

		wantU, wantZ := chainForward(n, weighted)
		if res.Z.Cmp(wantZ) != 0 {
			t.Fatalf("weighted=%v: Z=%s want %s", weighted, res.Z.RatString(), wantZ.RatString())
		}
		var gotU *big.Rat
		for _, e := range res.U {
			if e.Assignment[0] == "1" {
				gotU = e.Value
			}
		}
		if gotU == nil || gotU.Cmp(wantU) != 0 {
			t.Fatalf("weighted=%v: U(v=1) mismatch", weighted)
		}
		wantP := new(big.Rat).Quo(wantU, wantZ)
		var gotP *big.Rat
		for _, p := range res.Probability {
			if p.Assignment[0] == "1" {
				gotP = p.Value
			}
		}
		if gotP == nil || gotP.Cmp(wantP) != 0 {
			t.Fatalf("weighted=%v: P(v=1)=%v want %s", weighted, gotP, wantP.RatString())
		}
	}
}
