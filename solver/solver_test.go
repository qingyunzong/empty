package solver

import (
	"math/rand"
	"testing"
)

// randomInstance builds a reproducible random instance with n tests.
// Requires only point backwards, so the prerequisite graph is acyclic.
func randomInstance(rng *rand.Rand, n int) *Instance {
	nb := 1 + rng.Intn(8)
	np := 1 + rng.Intn(8)
	inst := &Instance{Name: "rand"}
	for i := 0; i < nb; i++ {
		inst.Branches = append(inst.Branches, "b"+itoa(i))
	}
	for i := 0; i < np; i++ {
		inst.Pairs = append(inst.Pairs, "p"+itoa(i))
	}
	totalTime := 0
	for i := 0; i < n; i++ {
		t := Test{
			ID:   "t" + itoa(i),
			Cost: rng.Intn(12), // zero costs allowed
			Time: 1 + rng.Intn(10),
		}
		if i > 0 && rng.Intn(3) == 0 {
			t.Requires = []string{"t" + itoa(rng.Intn(i))}
		}
		for j := 0; j < nb; j++ {
			if rng.Intn(2) == 0 {
				t.Branches = append(t.Branches, "b"+itoa(j))
			}
		}
		for j := 0; j < np; j++ {
			if rng.Intn(2) == 0 {
				t.Pairs = append(t.Pairs, "p"+itoa(j))
			}
		}
		totalTime += t.Time
		inst.Tests = append(inst.Tests, t)
	}
	// Time limit between 30% and 100% of the total: mixes feasible and
	// infeasible instances.
	inst.TimeLimit = totalTime*3/10 + rng.Intn(totalTime*7/10+1)
	return inst
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [8]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}

// TestBranchBoundVsExhaustive cross-checks the branch-and-bound solver
// against exhaustive enumeration on many small random instances.
func TestBranchBoundVsExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 400; trial++ {
		n := 2 + rng.Intn(13) // 2..14 tests
		inst := randomInstance(rng, n)
		got, err := Solve(inst, nil)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		want, err := SolveExhaustive(inst)
		if err != nil {
			t.Fatalf("trial %d: SolveExhaustive: %v", trial, err)
		}
		if got.Status != want.Status {
			t.Fatalf("trial %d: status %s, exhaustive says %s\ninstance: %+v",
				trial, got.Status, want.Status, inst)
		}
		if got.Status == Infeasible {
			continue
		}
		if got.Cost != want.Cost || got.Count != want.Count {
			t.Fatalf("trial %d: objective (cost=%d count=%d), exhaustive says (cost=%d count=%d)\ninstance: %+v",
				trial, got.Cost, got.Count, want.Cost, want.Count, inst)
		}
		if got.Stats.BoundCost != got.Cost || got.Stats.BoundCount != got.Count {
			t.Fatalf("trial %d: bound (cost=%d count=%d) does not certify objective (cost=%d count=%d)",
				trial, got.Stats.BoundCost, got.Stats.BoundCount, got.Cost, got.Count)
		}
		cert := BuildCertificate(inst, got)
		if err := VerifyCertificate(inst, cert, true); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
	}
}

// TestKnownOptima checks hand-computed instances.
func TestKnownOptima(t *testing.T) {
	cases := []struct {
		name     string
		inst     *Instance
		status   Status
		cost     int
		count    int
		selected []string
	}{
		{
			name: "single combined test beats two separate",
			inst: &Instance{
				Name:     "k1",
				Branches: []string{"b0", "b1"},
				Tests: []Test{
					{ID: "a", Cost: 5, Time: 5, Branches: []string{"b0"}},
					{ID: "b", Cost: 5, Time: 5, Branches: []string{"b1"}},
					{ID: "c", Cost: 9, Time: 9, Branches: []string{"b0", "b1"}},
				},
				TimeLimit: 100,
			},
			status: Optimal, cost: 9, count: 1, selected: []string{"c"},
		},
		{
			name: "prerequisite inflates combined test",
			inst: &Instance{
				Name:     "k2",
				Branches: []string{"b0", "b1"},
				Tests: []Test{
					{ID: "a", Cost: 5, Time: 5, Branches: []string{"b0"}},
					{ID: "b", Cost: 5, Time: 5, Branches: []string{"b1"}},
					{ID: "c", Cost: 9, Time: 9, Requires: []string{"d"}, Branches: []string{"b0", "b1"}},
					{ID: "d", Cost: 5, Time: 1},
				},
				TimeLimit: 100,
			},
			status: Optimal, cost: 10, count: 2, selected: []string{"a", "b"},
		},
		{
			name: "time limit forces infeasible",
			inst: &Instance{
				Name:     "k3",
				Branches: []string{"b0", "b1"},
				Tests: []Test{
					{ID: "a", Cost: 5, Time: 6, Branches: []string{"b0"}},
					{ID: "b", Cost: 5, Time: 6, Branches: []string{"b1"}},
				},
				TimeLimit: 10,
			},
			status: Infeasible,
		},
		{
			name: "cost wins over count",
			inst: &Instance{
				Name:     "k4",
				Branches: []string{"b0"},
				Pairs:    []string{"p0"},
				Tests: []Test{
					{ID: "cheap-pair", Cost: 3, Time: 1, Pairs: []string{"p0"}},
					{ID: "cheap-branch", Cost: 3, Time: 1, Branches: []string{"b0"}},
					{ID: "both", Cost: 7, Time: 2, Branches: []string{"b0"}, Pairs: []string{"p0"}},
				},
				TimeLimit: 10,
			},
			status: Optimal, cost: 6, count: 2, selected: []string{"cheap-branch", "cheap-pair"},
		},
		{
			name: "count breaks cost ties",
			inst: &Instance{
				Name:     "k5",
				Branches: []string{"b0", "b1"},
				Tests: []Test{
					{ID: "x", Cost: 4, Time: 1, Branches: []string{"b0"}},
					{ID: "y", Cost: 4, Time: 1, Branches: []string{"b1"}},
					{ID: "z", Cost: 8, Time: 1, Branches: []string{"b0", "b1"}},
				},
				TimeLimit: 10,
			},
			status: Optimal, cost: 8, count: 1, selected: []string{"z"},
		},
		{
			name: "prerequisite chain pulled in",
			inst: &Instance{
				Name:     "k6",
				Branches: []string{"b0"},
				Tests: []Test{
					{ID: "leaf", Cost: 1, Time: 1, Requires: []string{"mid"}, Branches: []string{"b0"}},
					{ID: "mid", Cost: 2, Time: 1, Requires: []string{"root"}},
					{ID: "root", Cost: 3, Time: 1},
				},
				TimeLimit: 10,
			},
			status: Optimal, cost: 6, count: 3, selected: []string{"leaf", "mid", "root"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := Solve(tc.inst, nil)
			if err != nil {
				t.Fatalf("Solve: %v", err)
			}
			if res.Status != tc.status {
				t.Fatalf("status = %s, want %s", res.Status, tc.status)
			}
			if tc.status == Infeasible {
				return
			}
			if res.Cost != tc.cost || res.Count != tc.count {
				t.Fatalf("objective = (cost=%d count=%d), want (cost=%d count=%d)",
					res.Cost, res.Count, tc.cost, tc.count)
			}
			cert := BuildCertificate(tc.inst, res)
			if len(cert.Selected) != len(tc.selected) {
				t.Fatalf("selected = %v, want %v", cert.Selected, tc.selected)
			}
			for i, id := range tc.selected {
				if cert.Selected[i] != id {
					t.Fatalf("selected = %v, want %v", cert.Selected, tc.selected)
				}
			}
			if err := VerifyCertificate(tc.inst, cert, true); err != nil {
				t.Fatalf("certificate invalid: %v", err)
			}
		})
	}
}

// TestCertificateTampering ensures verification rejects bad certificates.
func TestCertificateTampering(t *testing.T) {
	inst := &Instance{
		Name:     "tamper",
		Branches: []string{"b0"},
		Tests: []Test{
			{ID: "a", Cost: 5, Time: 1, Branches: []string{"b0"}},
			{ID: "setup", Cost: 1, Time: 1},
		},
		TimeLimit: 10,
	}
	res, err := Solve(inst, nil)
	if err != nil {
		t.Fatal(err)
	}
	good := BuildCertificate(inst, res)
	if err := VerifyCertificate(inst, good, true); err != nil {
		t.Fatalf("good certificate rejected: %v", err)
	}

	mutations := []struct {
		name   string
		mutate func(c *Certificate)
	}{
		{"drop coverage witness", func(c *Certificate) { c.Coverage = c.Coverage[:0] }},
		{"wrong witness test", func(c *Certificate) { c.Coverage[0].Test = "setup" }},
		{"understate cost", func(c *Certificate) { c.Cost-- }},
		{"add unknown test", func(c *Certificate) { c.Selected = append(c.Selected, "ghost") }},
		{"break closure", func(c *Certificate) {
			// Claim a covers b0 but requires setup which is not selected.
			inst.Tests[0].Requires = []string{"setup"}
			c.Selected = []string{"a"}
			c.Cost, c.Count, c.Time = 5, 1, 1
		}},
	}
	for _, m := range mutations {
		t.Run(m.name, func(t *testing.T) {
			res, err := Solve(inst, nil)
			if err != nil {
				t.Fatal(err)
			}
			c := BuildCertificate(inst, res)
			m.mutate(c)
			if err := VerifyCertificate(inst, c, true); err == nil {
				t.Fatalf("tampered certificate accepted")
			}
		})
	}
}

// TestValidation covers input validation errors.
func TestValidation(t *testing.T) {
	base := func() *Instance {
		return &Instance{
			Name:      "v",
			Branches:  []string{"b0"},
			TimeLimit: 10,
			Tests:     []Test{{ID: "a", Cost: 1, Time: 1, Branches: []string{"b0"}}},
		}
	}
	t.Run("too many tests", func(t *testing.T) {
		inst := base()
		for i := 0; i < MaxTests; i++ {
			inst.Tests = append(inst.Tests, Test{ID: "x" + itoa(i), Cost: 1, Time: 1})
		}
		if _, err := Solve(inst, nil); err == nil {
			t.Fatal("expected error for >24 tests")
		}
	})
	t.Run("duplicate test id", func(t *testing.T) {
		inst := base()
		inst.Tests = append(inst.Tests, inst.Tests[0])
		if _, err := Solve(inst, nil); err == nil {
			t.Fatal("expected error for duplicate id")
		}
	})
	t.Run("unknown prerequisite", func(t *testing.T) {
		inst := base()
		inst.Tests[0].Requires = []string{"ghost"}
		if _, err := Solve(inst, nil); err == nil {
			t.Fatal("expected error for unknown prerequisite")
		}
	})
	t.Run("unknown branch coverage", func(t *testing.T) {
		inst := base()
		inst.Tests[0].Branches = []string{"nope"}
		if _, err := Solve(inst, nil); err == nil {
			t.Fatal("expected error for unknown branch")
		}
	})
	t.Run("negative cost", func(t *testing.T) {
		inst := base()
		inst.Tests[0].Cost = -1
		if _, err := Solve(inst, nil); err == nil {
			t.Fatal("expected error for negative cost")
		}
	})
	t.Run("uncoverable requirement is infeasible", func(t *testing.T) {
		inst := base()
		inst.Pairs = []string{"p0"}
		res, err := Solve(inst, nil)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != Infeasible {
			t.Fatalf("status = %s, want INFEASIBLE", res.Status)
		}
	})
}

// TestNodeBudget checks the Feasible status path when the node budget
// interrupts the proof.
func TestNodeBudget(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	inst := randomInstance(rng, 14)
	res, err := Solve(inst, &Options{MaxNodes: 1})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status == Infeasible {
		t.Skip("instance infeasible, budget path not exercised")
	}
	if res.Status != Feasible && res.Status != Optimal {
		t.Fatalf("unexpected status %s", res.Status)
	}
	cert := BuildCertificate(inst, res)
	if err := VerifyCertificate(inst, cert, false); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
}

// TestSolveMaxSize solves harder 24-test instances (the supported maximum)
// and checks the certificate; exhaustive cross-check is impractical here,
// so the proven bound is the certificate of optimality.
func TestSolveMaxSize(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 4, 5} {
		rng := rand.New(rand.NewSource(seed))
		inst := hardInstance(rng, 24, 12, 12)
		res, err := Solve(inst, nil)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != Optimal && res.Status != Infeasible {
			t.Fatalf("seed %d: unexpected status %s", seed, res.Status)
		}
		if res.Status == Infeasible {
			continue
		}
		if res.Stats.BoundCost != res.Cost || res.Stats.BoundCount != res.Count {
			t.Fatalf("seed %d: bound (%d,%d) does not certify objective (%d,%d)",
				seed, res.Stats.BoundCost, res.Stats.BoundCount, res.Cost, res.Count)
		}
		cert := BuildCertificate(inst, res)
		if err := VerifyCertificate(inst, cert, true); err != nil {
			t.Fatalf("seed %d: certificate invalid: %v", seed, err)
		}
	}
}

// hardInstance builds sparse-coverage instances with a tight time limit.
func hardInstance(rng *rand.Rand, n, nb, np int) *Instance {
	inst := &Instance{Name: "hard"}
	for i := 0; i < nb; i++ {
		inst.Branches = append(inst.Branches, "b"+itoa(i))
	}
	for i := 0; i < np; i++ {
		inst.Pairs = append(inst.Pairs, "p"+itoa(i))
	}
	total := 0
	for i := 0; i < n; i++ {
		t := Test{ID: "t" + itoa(i), Cost: 1 + rng.Intn(6), Time: 1 + rng.Intn(6)}
		if i > 0 && rng.Intn(4) == 0 {
			t.Requires = []string{"t" + itoa(rng.Intn(i))}
		}
		for j := 0; j < nb; j++ {
			if rng.Intn(4) == 0 {
				t.Branches = append(t.Branches, "b"+itoa(j))
			}
		}
		for j := 0; j < np; j++ {
			if rng.Intn(4) == 0 {
				t.Pairs = append(t.Pairs, "p"+itoa(j))
			}
		}
		total += t.Time
		inst.Tests = append(inst.Tests, t)
	}
	inst.TimeLimit = total / 3
	return inst
}
