package contractopt

import (
	"math/rand"
	"testing"
)

// TestReviseMatchesBruteForce is the enumeration acceptance check for
// revision: on random small instances with one randomly revised contract,
// Revise must agree with exhaustive enumeration on the minimal number of
// changes and the resulting optimal objective.
func TestReviseMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	checked := 0
	for checked < 100 {
		inst := randInstance(rng, 2+rng.Intn(6)) // 2..7 contracts
		oldRes, err := Solve(inst)
		if err == ErrInfeasible {
			continue
		}
		if err != nil {
			t.Fatalf("Solve: %v", err)
		}
		var cand []int
		for i := range inst.Contracts {
			if !inst.Contracts[i].Locked {
				cand = append(cand, i)
			}
		}
		if len(cand) == 0 {
			continue
		}
		mutateContract(rng, inst, cand[rng.Intn(len(cand))])

		got, err := Revise(inst, oldRes.Alloc)
		if err == ErrInfeasible {
			continue
		}
		if err != nil {
			t.Fatalf("Revise: %v", err)
		}
		want, err := BruteForceRevise(inst, oldRes.Alloc)
		if err != nil {
			t.Fatalf("BruteForceRevise: %v", err)
		}
		if got.Changes != want.Changes || got.Revenue != want.Revenue || got.Usage != want.Usage {
			t.Fatalf("Revise = (ch %d, rev %d, usage %d), BruteForceRevise = (ch %d, rev %d, usage %d)",
				got.Changes, got.Revenue, got.Usage, want.Changes, want.Revenue, want.Usage)
		}
		if err := inst.Check(got.New); err != nil {
			t.Fatalf("revised allocation infeasible: %v", err)
		}
		if err := got.Cert.Verify(inst, got.New); err != nil {
			t.Fatalf("certificate does not verify: %v", err)
		}
		ev := got.Evidence
		if ev.ChangesLower > got.Changes || ev.ChangesUpper != got.Changes {
			t.Fatalf("change bounds [%d,%d] inconsistent with %d changes",
				ev.ChangesLower, ev.ChangesUpper, got.Changes)
		}
		if ev.RevenueLower != got.Revenue || ev.RevenueUpper < got.Revenue {
			t.Fatalf("revenue bounds [%d,%d] inconsistent with %d",
				ev.RevenueLower, ev.RevenueUpper, got.Revenue)
		}
		checked++
	}
}

// TestReviseMinChanges: revising A's usage makes the old allocation
// infeasible; the cheapest fix drops exactly one contract and keeps the
// higher-revenue one.
func TestReviseMinChanges(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{4}},
		Contracts: []Contract{
			{ID: "A", Revenue: 10, Usage: []int64{2}, Duration: 1, Starts: []int{0}},
			{ID: "B", Revenue: 9, Usage: []int64{2}, Duration: 1, Starts: []int{0}},
		},
	}
	old, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if old.Revenue != 19 {
		t.Fatalf("old revenue %d, want 19", old.Revenue)
	}
	inst.Contracts[0].Usage[0] = 3 // A now needs 3; A+B no longer fits
	rev, err := Revise(inst, old.Alloc)
	if err != nil {
		t.Fatal(err)
	}
	if rev.Changes != 1 {
		t.Fatalf("changes %d, want 1", rev.Changes)
	}
	if rev.Revenue != 10 || !rev.New.Selected("A") || rev.New.Selected("B") {
		t.Fatalf("new allocation %v revenue %d, want only A with revenue 10", rev.New.Sorted(), rev.Revenue)
	}
	if rev.Evidence.ChangesLower != 1 || rev.Evidence.ChangesUpper != 1 {
		t.Fatalf("change bounds [%d,%d], want [1,1]", rev.Evidence.ChangesLower, rev.Evidence.ChangesUpper)
	}
}

// TestReviseNoChangeNeeded: a revenue-only revision keeps the old allocation
// feasible and optimal, so zero changes suffice.
func TestReviseNoChangeNeeded(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{4}},
		Contracts: []Contract{
			{ID: "A", Revenue: 10, Usage: []int64{2}, Duration: 1, Starts: []int{0}},
			{ID: "B", Revenue: 9, Usage: []int64{2}, Duration: 1, Starts: []int{0}},
		},
	}
	old, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	inst.Contracts[1].Revenue = 8
	rev, err := Revise(inst, old.Alloc)
	if err != nil {
		t.Fatal(err)
	}
	if rev.Changes != 0 || rev.Revenue != 18 {
		t.Fatalf("changes %d revenue %d, want 0 changes and revenue 18", rev.Changes, rev.Revenue)
	}
	if rev.Evidence.ChangesLower != 0 {
		t.Fatalf("changes lower bound %d, want 0", rev.Evidence.ChangesLower)
	}
}

// TestReviseLockedStaysPut: locked contracts cannot be moved even when the
// revision would make a different placement attractive.
func TestReviseLockedStaysPut(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{5}, {5}, {5}},
		Contracts: []Contract{
			{ID: "A", Revenue: 4, Usage: []int64{5}, Duration: 1, Locked: true, LockedStart: 1},
			{ID: "B", Revenue: 6, Usage: []int64{5}, Duration: 1, Starts: []int{0, 1, 2}},
		},
	}
	old, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	// B becomes much more valuable; it still cannot displace locked A at 1.
	inst.Contracts[1].Revenue = 100
	rev, err := Revise(inst, old.Alloc)
	if err != nil {
		t.Fatal(err)
	}
	if rev.New.Starts["A"] != 1 {
		t.Fatalf("locked A moved to %d", rev.New.Starts["A"])
	}
	if st := rev.New.Starts["B"]; st == 1 {
		t.Fatalf("B overlaps locked A at period 1")
	}
	if rev.Changes != 0 {
		t.Fatalf("changes %d, want 0 (old allocation still feasible and optimal)", rev.Changes)
	}
}
