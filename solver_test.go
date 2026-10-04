package main

import (
	"math/rand"
	"testing"
)

// randomSpec builds a deterministic pseudo-random instance with n tests.
func randomSpec(rng *rand.Rand, n int) *Spec {
	s := &Spec{Name: "rand", TimeLimit: 0}
	nBranches := 1 + rng.Intn(4)
	for i := 0; i < nBranches; i++ {
		s.Branches = append(s.Branches, string(rune('a'+i)))
	}
	feats := []string{"os", "db", "browser"}[:1+rng.Intn(3)]
	s.Features = map[string][]string{}
	for _, f := range feats {
		s.Features[f] = []string{"x", "y"}
	}
	totalDur := 0
	for i := 0; i < n; i++ {
		t := TestSpec{Name: string(rune('A' + i))}
		t.Cost = rng.Intn(10)
		t.Duration = rng.Intn(8)
		totalDur += t.Duration
		for _, b := range s.Branches {
			if rng.Intn(3) == 0 {
				t.Branches = append(t.Branches, b)
			}
		}
		t.Assign = map[string]string{}
		for _, f := range feats {
			if rng.Intn(2) == 0 {
				t.Assign[f] = s.Features[f][rng.Intn(2)]
			}
		}
		for j := 0; j < n; j++ {
			if j != i && rng.Intn(8) == 0 {
				t.Requires = append(t.Requires, string(rune('A'+j)))
			}
		}
		s.Tests = append(s.Tests, t)
	}
	// Sometimes tight, sometimes loose.
	s.TimeLimit = rng.Intn(totalDur + 1)
	return s
}

// verifySelection checks that r.tests is a genuinely feasible selection
// attaining r.obj.
func verifySelection(t *testing.T, m *model, r result) {
	t.Helper()
	covered := newBitset(len(m.elemNames))
	cost, dur := 0, 0
	var mask uint32
	for _, idx := range r.tests {
		mask |= 1 << uint(idx)
	}
	for _, idx := range r.tests {
		if m.closure[idx]&^mask != 0 {
			t.Fatalf("selection not closed under requires: test %d", idx)
		}
		covered.or(m.cov[idx])
		cost += m.cost[idx]
		dur += m.dur[idx]
	}
	if !covered.covers(m.full) {
		t.Fatalf("selection does not cover the universe")
	}
	if dur > m.spec.TimeLimit {
		t.Fatalf("selection exceeds time limit: %d > %d", dur, m.spec.TimeLimit)
	}
	if cost != r.obj.cost || len(r.tests) != r.obj.count {
		t.Fatalf("reported objective %+v does not match selection cost=%d count=%d",
			r.obj, cost, len(r.tests))
	}
}

func TestSolveMatchesExhaustive(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		n := 1 + rng.Intn(14)
		spec := randomSpec(rng, n)
		if err := spec.validate(); err != nil {
			t.Fatalf("seed %d: generated invalid spec: %v", seed, err)
		}
		m := compile(spec)
		fast := solve(m)
		brute := exhaustive(m)
		if fast.feasible != brute.feasible {
			t.Fatalf("seed %d n=%d: feasibility mismatch fast=%v brute=%v",
				seed, n, fast.feasible, brute.feasible)
		}
		if !fast.feasible {
			continue
		}
		if fast.obj != brute.obj {
			t.Fatalf("seed %d n=%d: objective mismatch fast=%+v brute=%+v",
				seed, n, fast.obj, brute.obj)
		}
		verifySelection(t, m, fast)
		if fast.obj.cost < fast.initialLower {
			t.Fatalf("seed %d: optimal cost %d below initial lower bound %d",
				seed, fast.obj.cost, fast.initialLower)
		}
		if fast.initialUpper >= 0 && fast.obj.cost > fast.initialUpper {
			t.Fatalf("seed %d: optimal cost %d above greedy upper bound %d",
				seed, fast.obj.cost, fast.initialUpper)
		}
	}
}

func TestDemoInstance(t *testing.T) {
	spec, err := loadSpec("examples/demo.json")
	if err != nil {
		t.Fatal(err)
	}
	m := compile(spec)
	fast := solve(m)
	if !fast.feasible {
		t.Fatal("demo instance should be feasible")
	}
	brute := exhaustive(m)
	if fast.obj != brute.obj {
		t.Fatalf("demo: fast=%+v brute=%+v", fast.obj, brute.obj)
	}
	verifySelection(t, m, fast)
	c := buildCertificate(m, fast)
	if c.Status != "optimal" {
		t.Fatalf("certificate status = %q", c.Status)
	}
	if c.Coverage.Covered != c.Coverage.Total {
		t.Fatalf("certificate coverage %d/%d", c.Coverage.Covered, c.Coverage.Total)
	}
	if c.TimeUsed > c.TimeLimit {
		t.Fatalf("certificate time %d > limit %d", c.TimeUsed, c.TimeLimit)
	}
	if _, err := c.json(); err != nil {
		t.Fatal(err)
	}
	t.Logf("demo optimum: cost=%d tests=%d time=%d nodes=%d",
		fast.obj.cost, fast.obj.count, c.TimeUsed, fast.nodes)
}

func TestPrereqChainForcesInclusion(t *testing.T) {
	spec := &Spec{
		Name:      "chain",
		Branches:  []string{"b1"},
		TimeLimit: 100,
		Tests: []TestSpec{
			{Name: "base", Cost: 10, Duration: 1},
			{Name: "mid", Cost: 1, Duration: 1, Requires: []string{"base"}},
			{Name: "top", Cost: 1, Duration: 1, Requires: []string{"mid"}, Branches: []string{"b1"}},
		},
	}
	m := compile(spec)
	r := solve(m)
	if !r.feasible {
		t.Fatal("expected feasible")
	}
	// "top" is the only test covering b1, so the whole chain is forced.
	if r.obj.cost != 12 || r.obj.count != 3 {
		t.Fatalf("obj = %+v, want cost=12 count=3", r.obj)
	}
}

func TestTimeLimitBinding(t *testing.T) {
	spec := &Spec{
		Name:      "timelimit",
		Branches:  []string{"b1", "b2"},
		TimeLimit: 10,
		Tests: []TestSpec{
			// Cheap but slow: covers everything, exceeds the limit alone? No:
			// it fits, so make the cheap option too slow instead.
			{Name: "cheap-slow", Cost: 1, Duration: 11, Branches: []string{"b1", "b2"}},
			{Name: "fast-a", Cost: 5, Duration: 5, Branches: []string{"b1"}},
			{Name: "fast-b", Cost: 5, Duration: 5, Branches: []string{"b2"}},
		},
	}
	m := compile(spec)
	r := solve(m)
	if !r.feasible {
		t.Fatal("expected feasible")
	}
	if r.obj.cost != 10 || r.obj.count != 2 {
		t.Fatalf("obj = %+v, want cost=10 count=2", r.obj)
	}
}

func TestInfeasibleUncoverable(t *testing.T) {
	spec := &Spec{
		Name:      "infeasible",
		Branches:  []string{"b1", "b2"},
		TimeLimit: 100,
		Tests: []TestSpec{
			{Name: "only-b1", Cost: 1, Duration: 1, Branches: []string{"b1"}},
		},
	}
	m := compile(spec)
	r := solve(m)
	if r.feasible {
		t.Fatal("expected infeasible")
	}
	c := buildCertificate(m, r)
	if c.Status != "infeasible" || len(c.Coverage.Missing) != 1 {
		t.Fatalf("certificate = %+v", c)
	}
}

func TestInfeasibleTimeLimit(t *testing.T) {
	spec := &Spec{
		Name:      "infeasible-time",
		Branches:  []string{"b1"},
		TimeLimit: 3,
		Tests: []TestSpec{
			{Name: "slow", Cost: 1, Duration: 4, Branches: []string{"b1"}},
		},
	}
	m := compile(spec)
	if r := solve(m); r.feasible {
		t.Fatal("expected infeasible due to time limit")
	}
	if r := exhaustive(m); r.feasible {
		t.Fatal("exhaustive disagrees")
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	spec := &Spec{
		Name:      "tiebreak",
		Branches:  []string{"b1", "b2"},
		TimeLimit: 100,
		Tests: []TestSpec{
			{Name: "both", Cost: 4, Duration: 1, Branches: []string{"b1", "b2"}},
			{Name: "a", Cost: 2, Duration: 1, Branches: []string{"b1"}},
			{Name: "b", Cost: 2, Duration: 1, Branches: []string{"b2"}},
		},
	}
	m := compile(spec)
	r := solve(m)
	if !r.feasible {
		t.Fatal("expected feasible")
	}
	// Same cost (4): the single test "both" must win on count.
	if r.obj.cost != 4 || r.obj.count != 1 {
		t.Fatalf("obj = %+v, want cost=4 count=1", r.obj)
	}
	if len(r.tests) != 1 || m.spec.Tests[r.tests[0]].Name != "both" {
		names := []string{}
		for _, i := range r.tests {
			names = append(names, m.spec.Tests[i].Name)
		}
		t.Fatalf("selected %v, want [both]", names)
	}
}

func TestZeroCostTests(t *testing.T) {
	spec := &Spec{
		Name:      "zerocost",
		Branches:  []string{"b1"},
		TimeLimit: 100,
		Tests: []TestSpec{
			{Name: "free", Cost: 0, Duration: 1, Branches: []string{"b1"}},
			{Name: "pricey", Cost: 5, Duration: 1, Branches: []string{"b1"}},
		},
	}
	m := compile(spec)
	r := solve(m)
	if !r.feasible || r.obj.cost != 0 || r.obj.count != 1 {
		t.Fatalf("obj = %+v feasible=%v", r.obj, r.feasible)
	}
}

func TestValidation(t *testing.T) {
	big := &Spec{Name: "big", TimeLimit: 1}
	for i := 0; i < maxTests+1; i++ {
		big.Tests = append(big.Tests, TestSpec{Name: string(rune('a' + i))})
	}
	if err := big.validate(); err == nil {
		t.Fatal("expected error for >24 tests")
	}
	bad := &Spec{
		Name:      "bad",
		TimeLimit: 1,
		Tests:     []TestSpec{{Name: "x", Requires: []string{"ghost"}}},
	}
	if err := bad.validate(); err == nil {
		t.Fatal("expected error for unknown requires")
	}
	dup := &Spec{
		Name:      "dup",
		TimeLimit: 1,
		Tests:     []TestSpec{{Name: "x"}, {Name: "x"}},
	}
	if err := dup.validate(); err == nil {
		t.Fatal("expected error for duplicate names")
	}
}

func TestRequireCycle(t *testing.T) {
	spec := &Spec{
		Name:      "cycle",
		Branches:  []string{"b1"},
		TimeLimit: 100,
		Tests: []TestSpec{
			{Name: "p", Cost: 3, Duration: 1, Requires: []string{"q"}},
			{Name: "q", Cost: 3, Duration: 1, Requires: []string{"p"}, Branches: []string{"b1"}},
		},
	}
	m := compile(spec)
	r := solve(m)
	if !r.feasible {
		t.Fatal("expected feasible")
	}
	// The cycle forces both tests in together.
	if r.obj.cost != 6 || r.obj.count != 2 {
		t.Fatalf("obj = %+v, want cost=6 count=2", r.obj)
	}
	brute := exhaustive(m)
	if brute.obj != r.obj {
		t.Fatalf("exhaustive disagrees: %+v", brute.obj)
	}
}
