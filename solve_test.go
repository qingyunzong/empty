package contractopt

import (
	"math/rand"
	"testing"
)

func mustSolve(t *testing.T, in *Instance) Result {
	t.Helper()
	res, err := Solve(in)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	return res
}

func TestTieBreakPrefersSmallerUsage(t *testing.T) {
	in := &Instance{
		Periods: 1, Resources: 1,
		Capacity: [][]int64{{5}},
		Contracts: []Contract{
			{ID: "heavy", Revenue: 10, Duration: 1, Demand: []int64{5}, Starts: []int{0}},
			{ID: "light", Revenue: 10, Duration: 1, Demand: []int64{3}, Starts: []int{0}},
		},
		MaxSelect: 20,
	}
	res := mustSolve(t, in)
	if res.Solution.Revenue != 10 || res.Solution.Usage != 3 {
		t.Fatalf("got revenue=%d usage=%d, want 10/3", res.Solution.Revenue, res.Solution.Usage)
	}
	if _, ok := res.Solution.Assign["light"]; !ok {
		t.Fatalf("expected light to be selected, got %v", res.Solution.Assign)
	}
	if err := res.Certificate.Verify(in, res.Solution); err != nil {
		t.Fatalf("certificate: %v", err)
	}
	if len(res.Certificate.Saturated) != 0 {
		t.Fatalf("expected no saturated slot, got %+v", res.Certificate.Saturated)
	}
}

func TestCertificateSaturatedSlot(t *testing.T) {
	in := &Instance{
		Periods: 1, Resources: 1,
		Capacity: [][]int64{{2}},
		Contracts: []Contract{
			{ID: "a", Revenue: 5, Duration: 1, Demand: []int64{2}, Starts: []int{0}},
		},
		MaxSelect: 20,
	}
	res := mustSolve(t, in)
	if !res.Certificate.SaturatedSlot(0, 0) {
		t.Fatalf("expected slot (0,0) saturated, got %+v", res.Certificate.Saturated)
	}
	if err := res.Certificate.Verify(in, res.Solution); err != nil {
		t.Fatalf("certificate: %v", err)
	}
}

func TestPrereqMustFinishBeforeStart(t *testing.T) {
	in := &Instance{
		Periods: 4, Resources: 1,
		Capacity: [][]int64{{9}, {9}, {9}, {9}},
		Contracts: []Contract{
			{ID: "a", Revenue: 5, Duration: 2, Demand: []int64{1}, Starts: []int{0}},
			{ID: "b", Revenue: 7, Duration: 1, Demand: []int64{1}, Starts: []int{0, 1, 2, 3}, Prereqs: []string{"a"}},
		},
		MaxSelect: 20,
	}
	res := mustSolve(t, in)
	if got := res.Solution.Assign["b"]; got != 2 {
		t.Fatalf("b started at %d, want 2 (a finishes at period 2)", got)
	}
	found := false
	for _, e := range res.Certificate.UsedPrereqs {
		if e == [2]string{"a", "b"} {
			found = true
		}
	}
	if !found {
		t.Fatalf("certificate missing prereq edge a->b: %+v", res.Certificate.UsedPrereqs)
	}
}

func TestPrereqNotSelectedBlocksDependent(t *testing.T) {
	in := &Instance{
		Periods: 2, Resources: 1,
		Capacity: [][]int64{{1}, {1}},
		Contracts: []Contract{
			{ID: "a", Revenue: -5, Duration: 1, Demand: []int64{1}, Starts: []int{0}},
			{ID: "b", Revenue: 10, Duration: 1, Demand: []int64{1}, Starts: []int{1}, Prereqs: []string{"a"}},
		},
		MaxSelect: 20,
	}
	res := mustSolve(t, in)
	// Selecting b forces a (net revenue 5) which still beats skipping both.
	if res.Solution.Revenue != 5 || len(res.Solution.Assign) != 2 {
		t.Fatalf("got revenue=%d assign=%v, want 5 with both selected", res.Solution.Revenue, res.Solution.Assign)
	}
}

func TestMutexGroupAtMostOne(t *testing.T) {
	in := &Instance{
		Periods: 1, Resources: 1,
		Capacity: [][]int64{{9}},
		Contracts: []Contract{
			{ID: "x", Revenue: 4, Duration: 1, Demand: []int64{1}, Starts: []int{0}, Group: "g"},
			{ID: "y", Revenue: 6, Duration: 1, Demand: []int64{1}, Starts: []int{0}, Group: "g"},
			{ID: "z", Revenue: 1, Duration: 1, Demand: []int64{1}, Starts: []int{0}},
		},
		MaxSelect: 20,
	}
	res := mustSolve(t, in)
	if _, ok := res.Solution.Assign["y"]; !ok {
		t.Fatalf("expected y selected, got %v", res.Solution.Assign)
	}
	if _, ok := res.Solution.Assign["x"]; ok {
		t.Fatalf("x must be excluded by mutex group, got %v", res.Solution.Assign)
	}
	if res.Solution.Revenue != 7 {
		t.Fatalf("revenue=%d, want 7", res.Solution.Revenue)
	}
	if len(res.Certificate.FullGroups) != 1 || res.Certificate.FullGroups[0] != "g" {
		t.Fatalf("FullGroups=%v, want [g]", res.Certificate.FullGroups)
	}
}

func TestSelectionLimit(t *testing.T) {
	in := &Instance{
		Periods: 1, Resources: 1,
		Capacity: [][]int64{{99}},
		Contracts: []Contract{
			{ID: "c1", Revenue: 1, Duration: 1, Demand: []int64{1}, Starts: []int{0}},
			{ID: "c2", Revenue: 2, Duration: 1, Demand: []int64{1}, Starts: []int{0}},
			{ID: "c3", Revenue: 3, Duration: 1, Demand: []int64{1}, Starts: []int{0}},
		},
		MaxSelect: 2,
	}
	res := mustSolve(t, in)
	if res.Solution.Revenue != 5 || len(res.Solution.Assign) != 2 {
		t.Fatalf("revenue=%d n=%d, want 5 and 2", res.Solution.Revenue, len(res.Solution.Assign))
	}
	if !res.Certificate.CountBinding {
		t.Fatalf("expected CountBinding")
	}
}

func TestLockedContractIsFixed(t *testing.T) {
	in := &Instance{
		Periods: 2, Resources: 1,
		Capacity: [][]int64{{3}, {3}},
		Contracts: []Contract{
			{ID: "old", Revenue: 1, Duration: 1, Demand: []int64{2}, Locked: true, Start: 0},
			{ID: "new", Revenue: 9, Duration: 1, Demand: []int64{2}, Starts: []int{0, 1}},
		},
		MaxSelect: 20,
	}
	res := mustSolve(t, in)
	if got := res.Solution.Assign["new"]; got != 1 {
		t.Fatalf("new started at %d, want 1 (period 0 capacity blocked by locked)", got)
	}
}

func TestInfeasibleLocked(t *testing.T) {
	in := &Instance{
		Periods: 1, Resources: 1,
		Capacity: [][]int64{{3}},
		Contracts: []Contract{
			{ID: "l1", Revenue: 1, Duration: 1, Demand: []int64{2}, Locked: true, Start: 0},
			{ID: "l2", Revenue: 1, Duration: 1, Demand: []int64{2}, Locked: true, Start: 0},
		},
		MaxSelect: 20,
	}
	if _, err := Solve(in); err != ErrInfeasible {
		t.Fatalf("err=%v, want ErrInfeasible", err)
	}
	if _, _, err := Enumerate(in); err != ErrInfeasible {
		t.Fatalf("Enumerate err=%v, want ErrInfeasible", err)
	}
}

func TestValidateRejectsBadInstances(t *testing.T) {
	base := func() *Instance {
		return &Instance{
			Periods: 1, Resources: 1,
			Capacity:  [][]int64{{1}},
			Contracts: []Contract{{ID: "a", Revenue: 1, Duration: 1, Demand: []int64{1}, Starts: []int{0}}},
			MaxSelect: 1,
		}
	}
	in := base()
	in.MaxSelect = 21
	if _, err := Solve(in); err == nil {
		t.Fatalf("expected error for MaxSelect > 20")
	}
	in = base()
	in.Contracts[0].Prereqs = []string{"ghost"}
	if _, err := Solve(in); err == nil {
		t.Fatalf("expected error for unknown prereq")
	}
	in = base()
	in.Contracts = append(in.Contracts, in.Contracts[0])
	if _, err := Solve(in); err == nil {
		t.Fatalf("expected error for duplicate IDs")
	}
}

// randomInstance builds a deterministic pseudo-random small instance.
func randomInstance(rng *rand.Rand) *Instance {
	periods := 3 + rng.Intn(3)
	resources := 1 + rng.Intn(2)
	cap := make([][]int64, periods)
	for p := range cap {
		cap[p] = make([]int64, resources)
		for r := range cap[p] {
			cap[p][r] = int64(2 + rng.Intn(7))
		}
	}
	n := 4 + rng.Intn(5)
	contracts := make([]Contract, n)
	for i := range contracts {
		dur := 1 + rng.Intn(2)
		if dur > periods {
			dur = periods
		}
		maxStart := periods - dur
		var starts []int
		for s := 0; s <= maxStart; s++ {
			if rng.Intn(2) == 0 {
				starts = append(starts, s)
			}
		}
		if len(starts) == 0 {
			starts = []int{rng.Intn(maxStart + 1)}
		}
		demand := make([]int64, resources)
		for r := range demand {
			demand[r] = int64(rng.Intn(4))
		}
		c := Contract{
			ID:       string(rune('a' + i)),
			Revenue:  int64(rng.Intn(31) - 5),
			Duration: dur,
			Demand:   demand,
			Starts:   starts,
		}
		if i > 0 && rng.Intn(4) == 0 {
			c.Prereqs = []string{string(rune('a' + rng.Intn(i)))}
		}
		if rng.Intn(3) == 0 {
			c.Group = string(rune('A' + rng.Intn(3)))
		}
		contracts[i] = c
	}
	if rng.Intn(3) == 0 {
		contracts[0].Locked = true
		contracts[0].Group = ""
		contracts[0].Prereqs = nil
		contracts[0].Starts = nil
		contracts[0].Start = rng.Intn(periods - contracts[0].Duration + 1)
	}
	maxSel := 2 + rng.Intn(MaxSelectLimit-1)
	if rng.Intn(2) == 0 {
		maxSel = MaxSelectLimit
	}
	return &Instance{
		Periods:   periods,
		Resources: resources,
		Capacity:  cap,
		Contracts: contracts,
		MaxSelect: maxSel,
	}
}

func TestSolveMatchesEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 400; trial++ {
		in := randomInstance(rng)
		res, err := Solve(in)
		best, _, enumErr := Enumerate(in)
		if err != nil || enumErr != nil {
			if err != enumErr {
				t.Fatalf("trial %d: Solve err=%v, Enumerate err=%v", trial, err, enumErr)
			}
			continue
		}
		if res.Solution.Revenue != best.Revenue || res.Solution.Usage != best.Usage {
			t.Fatalf("trial %d: Solve=(%d,%d) Enumerate=(%d,%d)",
				trial, res.Solution.Revenue, res.Solution.Usage, best.Revenue, best.Usage)
		}
		if _, err := in.Evaluate(res.Solution.Assign); err != nil {
			t.Fatalf("trial %d: infeasible solution: %v", trial, err)
		}
		if err := res.Certificate.Verify(in, res.Solution); err != nil {
			t.Fatalf("trial %d: certificate: %v", trial, err)
		}
		if err := VerifyOptimalByEnumeration(in, res.Solution); err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
	}
}
