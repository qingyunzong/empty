package contractopt

import (
	"math/rand"
	"testing"
)

// TestSolveMatchesBruteForce is the enumeration cross-check: on many random
// small instances the branch-and-bound solver must agree with exhaustive
// subset enumeration, and its output must verify as a certificate.
func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	checked := 0
	for checked < 100 {
		inst := randInstance(rng, 2+rng.Intn(7)) // 2..8 contracts
		got, err := Solve(inst)
		if err == ErrInfeasible {
			continue // infeasible locked set; not interesting here
		}
		if err != nil {
			t.Fatalf("Solve: %v", err)
		}
		want, err := BruteForce(inst)
		if err != nil {
			t.Fatalf("BruteForce: %v", err)
		}
		if got.Revenue != want.Revenue || got.Usage != want.Usage {
			t.Fatalf("Solve = (rev %d, usage %d), BruteForce = (rev %d, usage %d)",
				got.Revenue, got.Usage, want.Revenue, want.Usage)
		}
		if err := inst.Check(got.Alloc); err != nil {
			t.Fatalf("solver allocation infeasible: %v", err)
		}
		if err := got.Cert.Verify(inst, got.Alloc); err != nil {
			t.Fatalf("certificate does not verify: %v", err)
		}
		if got.Bounds.RevenueUpper < got.Revenue {
			t.Fatalf("upper bound %d below achieved revenue %d", got.Bounds.RevenueUpper, got.Revenue)
		}
		if got.Bounds.RevenueLower != got.Revenue {
			t.Fatalf("lower bound %d != achieved revenue %d", got.Bounds.RevenueLower, got.Revenue)
		}
		checked++
	}
}

func TestTieBreakPrefersLowerUsage(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{6}},
		Contracts: []Contract{
			{ID: "A", Revenue: 10, Usage: []int64{6}, Duration: 1, Starts: []int{0}},
			{ID: "B", Revenue: 10, Usage: []int64{4}, Duration: 1, Starts: []int{0}},
		},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Revenue != 10 || res.Usage != 4 {
		t.Fatalf("got revenue %d usage %d, want 10/4", res.Revenue, res.Usage)
	}
	if !res.Alloc.Selected("B") || res.Alloc.Selected("A") {
		t.Fatalf("want only B selected, got %v", res.Alloc.Sorted())
	}
}

func TestPrereqRequiresCompletion(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{100}, {100}, {100}, {100}},
		Contracts: []Contract{
			{ID: "A", Revenue: 5, Usage: []int64{1}, Duration: 2, Starts: []int{0}},
			{ID: "B", Revenue: 5, Usage: []int64{1}, Duration: 1, Starts: []int{0, 1, 2, 3}, Prereqs: []string{"A"}},
		},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Revenue != 10 {
		t.Fatalf("revenue %d, want 10", res.Revenue)
	}
	if st := res.Alloc.Starts["B"]; st < 2 {
		t.Fatalf("B starts at %d, prerequisite A ends at 2", st)
	}

	// If B can only start at 0 it can never follow A, so only A is selected.
	inst.Contracts[1].Starts = []int{0}
	res, err = Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Revenue != 5 || res.Alloc.Selected("B") {
		t.Fatalf("revenue %d selected %v, want revenue 5 without B", res.Revenue, res.Alloc.Sorted())
	}
}

func TestMutexAtMostOne(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{100}},
		Contracts: []Contract{
			{ID: "A", Revenue: 5, Usage: []int64{1}, Duration: 1, Starts: []int{0}, Group: "G"},
			{ID: "B", Revenue: 7, Usage: []int64{1}, Duration: 1, Starts: []int{0}, Group: "G"},
			{ID: "C", Revenue: 3, Usage: []int64{1}, Duration: 1, Starts: []int{0}},
		},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Revenue != 10 || !res.Alloc.Selected("B") || res.Alloc.Selected("A") || !res.Alloc.Selected("C") {
		t.Fatalf("revenue %d selected %v, want revenue 10 with B and C", res.Revenue, res.Alloc.Sorted())
	}
}

func TestLockedContractForced(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{5}, {5}, {5}},
		Contracts: []Contract{
			{ID: "A", Revenue: 4, Usage: []int64{5}, Duration: 1, Locked: true, LockedStart: 1},
			{ID: "B", Revenue: 6, Usage: []int64{5}, Duration: 1, Starts: []int{0, 1, 2}},
		},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Alloc.Starts["A"] != 1 {
		t.Fatalf("locked A at %d, want 1", res.Alloc.Starts["A"])
	}
	if st := res.Alloc.Starts["B"]; st == 1 {
		t.Fatalf("B overlaps locked A at period 1")
	}
	if res.Revenue != 10 {
		t.Fatalf("revenue %d, want 10", res.Revenue)
	}
}

func TestInfeasibleLockedSet(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{5}},
		Contracts: []Contract{
			{ID: "A", Revenue: 1, Usage: []int64{5}, Duration: 1, Locked: true, LockedStart: 0},
			{ID: "B", Revenue: 1, Usage: []int64{5}, Duration: 1, Locked: true, LockedStart: 0},
		},
	}
	if _, err := Solve(inst); err != ErrInfeasible {
		t.Fatalf("got %v, want ErrInfeasible", err)
	}
}

func TestAtMostTwentyContracts(t *testing.T) {
	inst := &Instance{Capacity: [][]int64{{1000}}}
	for i := 0; i < 25; i++ {
		inst.Contracts = append(inst.Contracts, Contract{
			ID:       string(rune('A' + i)),
			Revenue:  int64(i + 1),
			Usage:    []int64{1},
			Duration: 1,
			Starts:   []int{0},
		})
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Alloc.Count() != MaxContracts {
		t.Fatalf("selected %d contracts, limit is %d", res.Alloc.Count(), MaxContracts)
	}
	// Top 20 revenues are 6..25.
	want := int64(0)
	for i := 6; i <= 25; i++ {
		want += int64(i)
	}
	if res.Revenue != want {
		t.Fatalf("revenue %d, want %d", res.Revenue, want)
	}
}

func TestCertificateTamperFails(t *testing.T) {
	inst := &Instance{
		Capacity: [][]int64{{100}, {100}, {100}},
		Contracts: []Contract{
			{ID: "A", Revenue: 5, Usage: []int64{1}, Duration: 1, Starts: []int{0}},
			{ID: "B", Revenue: 5, Usage: []int64{1}, Duration: 1, Starts: []int{1, 2}, Prereqs: []string{"A"}},
		},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Cert.Verify(inst, res.Alloc); err != nil {
		t.Fatalf("honest certificate rejected: %v", err)
	}
	// Forge an earlier prerequisite end.
	bad := res.Cert
	bad.Contracts = append([]ContractProof(nil), res.Cert.Contracts...)
	bad.Contracts[1].Prereqs = append([]PrereqProof(nil), res.Cert.Contracts[1].Prereqs...)
	bad.Contracts[1].Prereqs[0].PrereqEnd = 0
	if err := bad.Verify(inst, res.Alloc); err == nil {
		t.Fatal("tampered certificate accepted")
	}
	// Drop a contract from the certificate.
	short := Certificate{Contracts: res.Cert.Contracts[:1]}
	if err := short.Verify(inst, res.Alloc); err == nil {
		t.Fatal("incomplete certificate accepted")
	}
}
