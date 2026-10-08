package sched

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestCheckValidSchedule(t *testing.T) {
	inst := Instance{
		NumPeople: 3,
		NumSlots:  3,
		Allowed: [][]Pair{
			AllPairs(3),
			AllPairs(3),
			AllPairs(3),
		},
	}
	s := Schedule{{0, 1}, {0, 2}, {1, 2}}
	if err := inst.Check(s); err != nil {
		t.Fatalf("valid schedule rejected: %v", err)
	}
}

func TestCheckViolations(t *testing.T) {
	base := Instance{
		NumPeople: 4,
		NumSlots:  4,
		Allowed: [][]Pair{
			AllPairs(4),
			AllPairs(4),
			AllPairs(4),
			AllPairs(4),
		},
	}
	cases := []struct {
		name string
		mod  func(*Instance)
		s    Schedule
	}{
		{"wrong length", nil, Schedule{{0, 1}}},
		{"unnormalized pair", nil, Schedule{{1, 0}, {0, 1}, {0, 1}, {0, 1}}},
		{"out of range", nil, Schedule{{0, 9}, {0, 1}, {0, 1}, {0, 1}}},
		{"not qualified", func(in *Instance) {
			in.Allowed[1] = []Pair{{2, 3}}
		}, Schedule{{0, 1}, {0, 1}, {0, 1}, {0, 1}}},
		{"adjacency break", nil, Schedule{{0, 1}, {2, 3}, {0, 1}, {0, 1}}},
		{"run too long", nil, Schedule{{0, 1}, {0, 1}, {0, 1}, {0, 1}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			inst := base
			if tc.mod != nil {
				inst.Allowed = append([][]Pair(nil), base.Allowed...)
				tc.mod(&inst)
			}
			if err := inst.Check(tc.s); err == nil {
				t.Fatalf("expected violation, got nil")
			}
		})
	}
}

func TestSolvePrefersLowCost(t *testing.T) {
	// Slot 1 must share a person with slot 0. Making person 0 expensive in
	// slot 1 forces the pair {1,2} there even though {0,1} is lex smaller.
	inst := Instance{
		NumPeople: 3,
		NumSlots:  2,
		Allowed:   [][]Pair{AllPairs(3), AllPairs(3)},
		Cost: [][]int{
			{0, 100},
			{0, 0},
			{0, 0},
		},
	}
	got, ok := inst.Solve()
	if !ok {
		t.Fatal("expected feasible")
	}
	want := Schedule{{0, 1}, {1, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if c := inst.TotalCost(got); c != 0 {
		t.Fatalf("cost = %d, want 0", c)
	}
	if err := inst.Check(got); err != nil {
		t.Fatalf("solver output failed Check: %v", err)
	}
}

func TestSolveLexTieBreak(t *testing.T) {
	// All costs zero: the lexicographically smallest feasible sequence wins.
	inst := Instance{
		NumPeople: 3,
		NumSlots:  3,
		Allowed:   [][]Pair{AllPairs(3), AllPairs(3), AllPairs(3)},
	}
	got, ok := inst.Solve()
	if !ok {
		t.Fatal("expected feasible")
	}
	want := Schedule{{0, 1}, {0, 1}, {0, 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestSolveRespectsMaxRun(t *testing.T) {
	// With 4 slots and 3 people fully qualified, person 0 cannot cover all
	// slots; the run cap forces a rotation.
	inst := Instance{
		NumPeople: 3,
		NumSlots:  4,
		Allowed:   [][]Pair{AllPairs(3), AllPairs(3), AllPairs(3), AllPairs(3)},
	}
	got, ok := inst.Solve()
	if !ok {
		t.Fatal("expected feasible")
	}
	if err := inst.Check(got); err != nil {
		t.Fatalf("solver output failed Check: %v", err)
	}
	// Person 0 cannot work all 4 slots, so the optimum rotates:
	want := Schedule{{0, 1}, {0, 1}, {0, 2}, {1, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestSolveInfeasible(t *testing.T) {
	// Two people must staff 4 slots, forcing a run of 4 > MaxRun.
	inst := Instance{
		NumPeople: 2,
		NumSlots:  4,
		Allowed: [][]Pair{
			{{0, 1}}, {{0, 1}}, {{0, 1}}, {{0, 1}},
		},
	}
	if _, ok := inst.Solve(); ok {
		t.Fatal("expected infeasible")
	}

	// Empty qualification list on one slot.
	inst2 := Instance{
		NumPeople: 3,
		NumSlots:  2,
		Allowed:   [][]Pair{AllPairs(3), {}},
	}
	if _, ok := inst2.Solve(); ok {
		t.Fatal("expected infeasible")
	}
}

func TestSolveEmptyInstance(t *testing.T) {
	inst := Instance{NumPeople: 0, NumSlots: 0, Allowed: nil}
	got, ok := inst.Solve()
	if !ok || len(got) != 0 {
		t.Fatalf("got %v, %v; want empty, true", got, ok)
	}
	if err := inst.Check(got); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

func TestValidateRejectsBadInput(t *testing.T) {
	bad := []Instance{
		{NumPeople: MaxPeople + 1},
		{NumSlots: MaxSlots + 1},
		{NumPeople: 3, NumSlots: 1, Allowed: nil},
		{NumPeople: 3, NumSlots: 1, Allowed: [][]Pair{{{0, 0}}}},
		{NumPeople: 3, NumSlots: 1, Allowed: [][]Pair{{{0, 3}}}},
		{NumPeople: 3, NumSlots: 1, Allowed: [][]Pair{{{0, 1}}}, Cost: [][]int{{0}}},
	}
	for i, inst := range bad {
		if err := inst.Validate(); err == nil {
			t.Fatalf("case %d: expected error", i)
		}
		if _, ok := inst.Solve(); ok {
			t.Fatalf("case %d: Solve accepted invalid instance", i)
		}
	}
}

// bruteForce enumerates every sequence of qualified pairs and returns the
// optimal one under the same (cost, lexicographic) ordering as Solve.
func bruteForce(inst Instance) (Schedule, bool) {
	var best Schedule
	bestCost := 0
	found := false
	runs := make([]int, inst.NumPeople)
	cur := make(Schedule, 0, inst.NumSlots)
	var rec func(slot int)
	rec = func(slot int) {
		if slot == inst.NumSlots {
			cost := inst.TotalCost(cur)
			if !found || cost < bestCost || (cost == bestCost && seqLess(cur, best)) {
				found, bestCost = true, cost
				best = append(Schedule(nil), cur...)
			}
			return
		}
		for _, p := range inst.Allowed[slot] {
			if slot > 0 && !cur[slot-1].shares(p) {
				continue
			}
			if runs[p.A] >= MaxRun || runs[p.B] >= MaxRun {
				continue
			}
			saved := append([]int(nil), runs...)
			for m := range runs {
				if m == p.A || m == p.B {
					runs[m]++
				} else {
					runs[m] = 0
				}
			}
			cur = append(cur, p)
			rec(slot + 1)
			cur = cur[:len(cur)-1]
			copy(runs, saved)
		}
	}
	rec(0)
	return best, found
}

// TestExhaustiveShortSequences compares Solve against brute-force enumeration
// on many small random instances.
func TestExhaustiveShortSequences(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 2000; trial++ {
		numPeople := 2 + rng.Intn(4) // 2..5
		numSlots := 1 + rng.Intn(6)  // 1..6
		all := AllPairs(numPeople)
		allowed := make([][]Pair, numSlots)
		for s := range allowed {
			for _, p := range all {
				if rng.Intn(100) < 70 {
					allowed[s] = append(allowed[s], p)
				}
			}
		}
		var cost [][]int
		if rng.Intn(2) == 0 {
			cost = make([][]int, numPeople)
			for p := range cost {
				cost[p] = make([]int, numSlots)
				for s := range cost[p] {
					cost[p][s] = rng.Intn(10)
				}
			}
		}
		inst := Instance{
			NumPeople: numPeople,
			NumSlots:  numSlots,
			Allowed:   allowed,
			Cost:      cost,
		}
		got, gotOK := inst.Solve()
		want, wantOK := bruteForce(inst)
		if gotOK != wantOK {
			t.Fatalf("trial %d: feasibility mismatch: Solve=%v brute=%v\ninst=%+v",
				trial, gotOK, wantOK, inst)
		}
		if !gotOK {
			continue
		}
		if inst.TotalCost(got) != inst.TotalCost(want) {
			t.Fatalf("trial %d: cost mismatch: Solve=%d brute=%d\ninst=%+v",
				trial, inst.TotalCost(got), inst.TotalCost(want), inst)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d: schedule mismatch:\nSolve=%v\nbrute=%v\ninst=%+v",
				trial, got, want, inst)
		}
		if err := inst.Check(got); err != nil {
			t.Fatalf("trial %d: solver output failed Check: %v", trial, err)
		}
	}
}

// TestSolveMaxSize smoke-tests the largest supported instance.
func TestSolveMaxSize(t *testing.T) {
	allowed := make([][]Pair, MaxSlots)
	for i := range allowed {
		allowed[i] = AllPairs(MaxPeople)
	}
	cost := make([][]int, MaxPeople)
	for p := range cost {
		cost[p] = make([]int, MaxSlots)
		for s := range cost[p] {
			cost[p][s] = (p*7 + s*3) % 11
		}
	}
	inst := Instance{NumPeople: MaxPeople, NumSlots: MaxSlots, Allowed: allowed, Cost: cost}
	got, ok := inst.Solve()
	if !ok {
		t.Fatal("expected feasible")
	}
	if err := inst.Check(got); err != nil {
		t.Fatalf("solver output failed Check: %v", err)
	}
}
