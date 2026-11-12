package wf

import (
	"math/rand"
	"testing"
)

// TestExhaustiveTinyPrograms enumerates every subset of a restricted template
// pool over two atoms. Both independent procedures must agree on every one
// of the 2^14 programs.
func TestExhaustiveTinyPrograms(t *testing.T) {
	const n = 2
	universe := []string{"a", "b"}
	var pool []Rule
	id := 0
	nextID := func() string {
		id++
		return "r" + itoa(id)
	}
	bodyOptions := []struct{ pos, neg []string }{
		{nil, nil},
		{[]string{"a"}, nil},
		{[]string{"b"}, nil},
		{nil, []string{"a"}},
		{nil, []string{"b"}},
		{[]string{"a"}, []string{"a"}},
		{[]string{"b"}, []string{"b"}},
	}
	for _, head := range universe {
		for _, opt := range bodyOptions {
			pool = append(pool, Rule{ID: nextID(), Head: head, Pos: opt.pos, Neg: opt.neg})
		}
	}
	if len(pool) != 14 {
		t.Fatalf("template pool size changed: %d", len(pool))
	}

	count := 0
	for mask := 0; mask < 1<<len(pool); mask++ {
		var rules []Rule
		for i := 0; i < len(pool); i++ {
			if mask&(1<<i) != 0 {
				rules = append(rules, pool[i])
			}
		}
		p, err := NewProgram(universe, rules)
		if err != nil {
			t.Fatalf("template program rejected: %v", err)
		}
		res := Evaluate(p)
		assertReferenceMatches(t, "exhaustive", p, res)
		assertRoundInvariants(t, "exhaustive", p, res)
		assertFalseSupports(t, "exhaustive", p, res)
		count++
	}
	t.Logf("compared %d exhaustive tiny programs", count)
}

// TestRandomProgramCrossCheck generates larger random ground programs and
// again requires the two independent procedures to agree, including every
// monotonicity and closed-support guarantee.
func TestRandomProgramCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	const programs = 800
	for iter := 0; iter < programs; iter++ {
		atomCount := 1 + rng.Intn(6)
		universe := make([]string, atomCount)
		for i := range universe {
			universe[i] = "atom" + itoa(i)
		}
		ruleCount := rng.Intn(14)
		rules := make([]Rule, ruleCount)
		for i := range rules {
			head := universe[rng.Intn(atomCount)]
			rules[i] = Rule{
				ID:   "rule" + itoa(i),
				Head: head,
				Pos:  randomSubset(rng, universe),
				Neg:  randomSubset(rng, universe),
			}
		}
		p, err := NewProgram(universe, rules)
		if err != nil {
			t.Fatalf("iteration %d: random program rejected: %v", iter, err)
		}
		res := Evaluate(p)
		assertReferenceMatches(t, "random", p, res)
		assertRoundInvariants(t, "random", p, res)
		assertFalseSupports(t, "random", p, res)
	}
}

func randomSubset(rng *rand.Rand, universe []string) []string {
	var out []string
	for _, atom := range universe {
		if rng.Intn(2) == 0 {
			out = append(out, atom)
		}
	}
	return out
}

// A positive cycle of false atoms is collectively unfounded: witnesses may
// point around the cycle, but every witness must be flagged as part of the
// same false component rather than presented as an independently proven truth.
func TestPositiveCycleCollectiveUnfoundedness(t *testing.T) {
	rules := []Rule{
		{ID: "r1", Head: "a", Pos: []string{"b"}},
		{ID: "r2", Head: "b", Pos: []string{"c"}},
		{ID: "r3", Head: "c", Pos: []string{"a"}},
		{ID: "r4", Head: "d", Pos: []string{"c"}},
	}
	res := assertScenario(t, "positive cycle",
		[]string{"a", "b", "c", "d"}, rules,
		nil, []string{"a", "b", "c", "d"}, nil)

	cycleWitnesses, externalWitnesses := 0, 0
	for _, support := range res.FalseSupports {
		for _, w := range support.Witnesses {
			if w.Kind != "pos_false" {
				t.Fatalf("expected only pos_false witnesses, got %+v", w)
			}
			if w.InCycle {
				cycleWitnesses++
			} else {
				externalWitnesses++
			}
		}
	}
	if cycleWitnesses != 3 {
		t.Fatalf("the three cycle rules need collective in-cycle witnesses, got %d", cycleWitnesses)
	}
	if externalWitnesses != 1 {
		t.Fatalf("the external head d is supported by a false premise outside its own SCC, got %d", externalWitnesses)
	}
}
