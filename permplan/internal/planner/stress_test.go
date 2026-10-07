package planner

import (
	"testing"
	"time"
)

func TestStress22UniformCosts(t *testing.T) {
	in := &Input{Demands: map[string]int{"a": 6, "b": 6, "c": 6}}
	for i := 0; i < 22; i++ {
		in.Rules = append(in.Rules, rule(
			string(rune('a'+i)), 1, 1, 0,
			map[string]int{"a": 2, "b": 2, "c": 2},
		))
	}
	start := time.Now()
	sol := mustSolve(t, in)
	t.Logf("uniform-cost 22-rule solve: %v, cost=%d, rules=%v", time.Since(start), sol.Cost, sol.Rules)
	if len(sol.Rules) != 3 {
		t.Fatalf("want 3 rules, got %v", sol.Rules)
	}
}
