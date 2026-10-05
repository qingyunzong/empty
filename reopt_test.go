package contractopt

import (
	"math/rand"
	"testing"
)

func TestReoptNoChangeWhenOldStillFeasible(t *testing.T) {
	in := &Instance{
		Periods: 2, Resources: 1,
		Capacity: [][]int64{{4}, {4}},
		Contracts: []Contract{
			{ID: "a", Revenue: 8, Duration: 1, Demand: []int64{2}, Starts: []int{0, 1}},
			{ID: "b", Revenue: 6, Duration: 1, Demand: []int64{2}, Starts: []int{0, 1}},
		},
		MaxSelect: 20,
	}
	old := mustSolve(t, in).Solution.Assign
	// Revise b's revenue only: the old assignment stays feasible.
	in.Contracts[1].Revenue = 60
	res, err := Reoptimize(in, old)
	if err != nil {
		t.Fatalf("Reoptimize: %v", err)
	}
	if res.Changes != 0 {
		t.Fatalf("Changes=%d, want 0", res.Changes)
	}
	if res.New.Revenue != 68 || res.ChangesLowerBound != 0 {
		t.Fatalf("revenue=%d lb=%d, want 68/0", res.New.Revenue, res.ChangesLowerBound)
	}
	if res.RevenueUpperBound < res.New.Revenue {
		t.Fatalf("upper bound %d < achieved %d", res.RevenueUpperBound, res.New.Revenue)
	}
	for id, s := range old {
		if res.New.Assign[id] != s {
			t.Fatalf("contract %s moved: old %v new %v", id, old, res.New.Assign)
		}
	}
}

func TestReoptAfterStartRevision(t *testing.T) {
	in := &Instance{
		Periods: 3, Resources: 1,
		Capacity: [][]int64{{2}, {2}, {2}},
		Contracts: []Contract{
			{ID: "a", Revenue: 9, Duration: 1, Demand: []int64{2}, Starts: []int{0}},
			{ID: "b", Revenue: 8, Duration: 1, Demand: []int64{2}, Starts: []int{0, 1, 2}},
		},
		MaxSelect: 20,
	}
	old := mustSolve(t, in).Solution.Assign // a@0, b@1 or b@2
	// Revise a: it can no longer start at 0, only at 2.
	in.Contracts[0].Starts = []int{2}
	res, err := Reoptimize(in, old)
	if err != nil {
		t.Fatalf("Reoptimize: %v", err)
	}
	if res.ChangesLowerBound != 1 {
		t.Fatalf("ChangesLowerBound=%d, want 1 (old assignment infeasible)", res.ChangesLowerBound)
	}
	if res.Changes != 1 {
		t.Fatalf("Changes=%d, want 1 (only a moves to period 2)", res.Changes)
	}
	if got := res.New.Assign["a"]; got != 2 {
		t.Fatalf("a started at %d, want 2", got)
	}
	if res.New.Revenue != 17 {
		t.Fatalf("revenue=%d, want 17", res.New.Revenue)
	}
	if res.RevenueLowerBound != res.New.Revenue {
		t.Fatalf("lower bound %d != achieved %d", res.RevenueLowerBound, res.New.Revenue)
	}
}

func TestReoptAfterDemandRevision(t *testing.T) {
	in := &Instance{
		Periods: 1, Resources: 1,
		Capacity: [][]int64{{4}},
		Contracts: []Contract{
			{ID: "a", Revenue: 9, Duration: 1, Demand: []int64{2}, Starts: []int{0}},
			{ID: "b", Revenue: 8, Duration: 1, Demand: []int64{2}, Starts: []int{0}},
			{ID: "c", Revenue: 1, Duration: 1, Demand: []int64{1}, Starts: []int{0}},
		},
		MaxSelect: 20,
	}
	old := mustSolve(t, in).Solution.Assign // a+b (revenue 17)
	// Revise a: demand grows to 3, so a+b no longer fits.
	in.Contracts[0].Demand = []int64{3}
	res, err := Reoptimize(in, old)
	if err != nil {
		t.Fatalf("Reoptimize: %v", err)
	}
	if res.Changes != 1 {
		t.Fatalf("Changes=%d, want 1 (drop b, keep a)", res.Changes)
	}
	if _, ok := res.New.Assign["a"]; !ok {
		t.Fatalf("expected a kept, got %v", res.New.Assign)
	}
	if _, ok := res.New.Assign["b"]; ok {
		t.Fatalf("expected b dropped, got %v", res.New.Assign)
	}
	if _, ok := res.New.Assign["c"]; ok {
		t.Fatalf("adding c would be a second change, got %v", res.New.Assign)
	}
	// One change keeps a alone (revenue 9); the unconstrained optimum of the
	// revised instance is a+c (revenue 10), which costs two changes.
	if res.RevenueUpperBound != 10 || res.New.Revenue != 9 {
		t.Fatalf("ub=%d rev=%d, want 10/9", res.RevenueUpperBound, res.New.Revenue)
	}
}

func reviseContract(rng *rand.Rand, in *Instance) {
	for {
		i := rng.Intn(len(in.Contracts))
		if in.Contracts[i].Locked {
			continue
		}
		c := &in.Contracts[i]
		c.Revenue = int64(rng.Intn(31) - 5)
		for r := range c.Demand {
			c.Demand[r] = int64(rng.Intn(4))
		}
		maxStart := in.Periods - c.Duration
		var starts []int
		for s := 0; s <= maxStart; s++ {
			if rng.Intn(2) == 0 {
				starts = append(starts, s)
			}
		}
		if len(starts) > 0 {
			c.Starts = starts
		}
		return
	}
}

func TestReoptMatchesEnumeration(t *testing.T) {
	rng := rand.New(rand.NewSource(77117711))
	for trial := 0; trial < 400; trial++ {
		in := randomInstance(rng)
		base, err := Solve(in)
		if err != nil {
			continue // no feasible old assignment to revise from
		}
		old := base.Solution.Assign
		reviseContract(rng, in)
		res, err := Reoptimize(in, old)
		want, enumErr := EnumerateReopt(in, old)
		if err != nil || enumErr != nil {
			if (err == nil) != (enumErr == nil) {
				t.Fatalf("trial %d: Reoptimize err=%v, EnumerateReopt err=%v", trial, err, enumErr)
			}
			continue
		}
		if res.Changes != want.Changes || res.New.Revenue != want.New.Revenue || res.New.Usage != want.New.Usage {
			t.Fatalf("trial %d: got (chg=%d rev=%d use=%d), enumeration wants (chg=%d rev=%d use=%d)",
				trial, res.Changes, res.New.Revenue, res.New.Usage,
				want.Changes, want.New.Revenue, want.New.Usage)
		}
		if _, err := in.Evaluate(res.New.Assign); err != nil {
			t.Fatalf("trial %d: infeasible reopt solution: %v", trial, err)
		}
		if res.ChangesLowerBound > res.Changes {
			t.Fatalf("trial %d: changes lower bound %d > %d", trial, res.ChangesLowerBound, res.Changes)
		}
		if res.RevenueUpperBound < res.New.Revenue {
			t.Fatalf("trial %d: revenue upper bound %d < %d", trial, res.RevenueUpperBound, res.New.Revenue)
		}
		if res.RevenueLowerBound != res.New.Revenue {
			t.Fatalf("trial %d: revenue lower bound %d != %d", trial, res.RevenueLowerBound, res.New.Revenue)
		}
	}
}
