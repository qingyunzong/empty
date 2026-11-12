package wf

import (
	"fmt"
	"testing"
)

func BenchmarkEvaluateMaxShape(b *testing.B) {
	const atoms = 1000
	const rules = 20000
	universe := make([]string, atoms)
	for i := range universe {
		universe[i] = fmt.Sprintf("atom%04d", i)
	}
	programRules := make([]Rule, rules)
	for i := range programRules {
		head := universe[i%atoms]
		pos := []string{}
		neg := []string{}
		if i >= atoms {
			pos = append(pos, universe[(i-1)%atoms])
			if i%3 == 0 {
				neg = append(neg, universe[(2*i)%atoms])
			}
		}
		programRules[i] = Rule{
			ID:   fmt.Sprintf("rule%05d", i),
			Head: head,
			Pos:  pos,
			Neg:  neg,
		}
	}
	p, err := NewProgram(universe, programRules)
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		res := Evaluate(p)
		if len(res.Rounds) == 0 {
			b.Fatal("expected at least one round")
		}
	}
}
