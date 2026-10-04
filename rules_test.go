package rules

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// --- Independent verification helpers (deliberately separate from the
// --- implementation under test). ---

// bruteFeasible decides feasibility by Bellman-Ford relaxation over n+1
// rounds, written independently of the library internals.
func bruteFeasible(numVars int, cs []Constraint) bool {
	d := make([]int64, numVars)
	for round := 0; round <= numVars; round++ {
		changed := false
		for _, c := range cs {
			if d[c.From]+c.Weight < d[c.To] {
				d[c.To] = d[c.From] + c.Weight
				changed = true
			}
		}
		if !changed {
			return true
		}
		if round == numVars {
			return false
		}
	}
	return true
}

// enumerateSubsets calls fn for every subset of ids, ordered by subset size.
func enumerateSubsets(ids []int, fn func(sub []int)) {
	n := len(ids)
	for mask := 0; mask < 1<<n; mask++ {
		var sub []int
		for i := 0; i < n; i++ {
			if mask>>i&1 == 1 {
				sub = append(sub, ids[i])
			}
		}
		fn(sub)
	}
}

// checkMinimalInfeasible independently verifies that got is a
// minimum-cardinality infeasible subset of all: got itself is infeasible,
// every proper subset of every constraint set smaller than got is feasible,
// and every proper subset of got is feasible.
func checkMinimalInfeasible(t *testing.T, numVars int, all []Constraint, got []int) {
	t.Helper()
	if len(got) == 0 {
		t.Fatal("empty conflict returned for infeasible system")
	}
	byID := map[int]Constraint{}
	var ids []int
	for _, c := range all {
		byID[c.ID] = c
		ids = append(ids, c.ID)
	}
	sort.Ints(ids)
	if !sort.IntsAreSorted(got) {
		t.Fatalf("conflict %v not sorted", got)
	}
	// Enumerate every subset independently.
	enumerateSubsets(ids, func(sub []int) {
		cs := make([]Constraint, len(sub))
		for i, id := range sub {
			cs[i] = byID[id]
		}
		bad := !bruteFeasible(numVars, cs)
		if len(sub) < len(got) && bad {
			t.Fatalf("smaller infeasible subset %v exists, conflict %v not minimal", sub, got)
		}
		if len(sub) == len(got) && reflect.DeepEqual(sub, got) && !bad {
			t.Fatalf("returned conflict %v is actually feasible", got)
		}
	})
	// Every proper subset of got must be feasible.
	enumerateSubsets(got, func(sub []int) {
		if len(sub) == len(got) {
			return
		}
		cs := make([]Constraint, len(sub))
		for i, id := range sub {
			cs[i] = byID[id]
		}
		if !bruteFeasible(numVars, cs) {
			t.Fatalf("proper subset %v of conflict %v is infeasible", sub, got)
		}
	})
}

func checkPotentials(t *testing.T, s *System) {
	t.Helper()
	if !s.Feasible() {
		t.Fatal("system unexpectedly infeasible")
	}
	p := s.Potentials()
	for _, c := range s.Constraints() {
		if p[c.To]-p[c.From] > c.Weight {
			t.Fatalf("potentials %v violate constraint %+v", p, c)
		}
	}
}

// --- Tests ---

func TestDerivedEdgeSources(t *testing.T) {
	s := NewSystem(3)
	if _, c, _ := s.Add(0, 1, 2); c != nil { // x1 - x0 <= 2, id 0
		t.Fatal("unexpected conflict")
	}
	if _, c, _ := s.Add(1, 2, 3); c != nil { // x2 - x1 <= 3, id 1
		t.Fatal("unexpected conflict")
	}
	e, ok := s.Derived(0, 2)
	if !ok {
		t.Fatal("missing derived edge 0 -> 2")
	}
	if e.Weight != 5 {
		t.Fatalf("derived weight = %d, want 5", e.Weight)
	}
	if !reflect.DeepEqual(e.Sources, []int{0, 1}) {
		t.Fatalf("derived sources = %v, want [0 1]", e.Sources)
	}
	// A parallel tighter direct edge rebinds the source.
	if _, c, _ := s.Add(0, 2, 4); c != nil { // id 2
		t.Fatal("unexpected conflict")
	}
	e, _ = s.Derived(0, 2)
	if e.Weight != 4 || !reflect.DeepEqual(e.Sources, []int{2}) {
		t.Fatalf("derived = %+v, want weight 4 sources [2]", e)
	}
	checkPotentials(t, s)
}

func TestNegativeCycleConflictAndDelete(t *testing.T) {
	s := NewSystem(3)
	s.Add(0, 1, 1) // id 0: x1 - x0 <= 1
	s.Add(1, 2, 1) // id 1: x2 - x1 <= 1
	s.Add(2, 0, 1) // id 2: x0 - x2 <= 1 (cycle sums to 3, still fine)
	checkPotentials(t, s)
	id, conflict, err := s.Add(2, 0, -5) // id 3: forces x0 - x2 <= -5
	if err != nil {
		t.Fatal(err)
	}
	if id != 3 {
		t.Fatalf("id = %d, want 3", id)
	}
	if s.Feasible() {
		t.Fatal("system should be infeasible")
	}
	// The negative cycle is x0->x1->x2->x0 with 1+1-5 = -3.
	want := []int{0, 1, 3}
	if !reflect.DeepEqual(conflict, want) {
		t.Fatalf("conflict = %v, want %v", conflict, want)
	}
	checkMinimalInfeasible(t, 3, s.Constraints(), conflict)

	// Deleting the offending constraint restores feasible potentials.
	if err := s.Delete(id); err != nil {
		t.Fatal(err)
	}
	checkPotentials(t, s)
	// Deleting an unknown ID fails.
	if err := s.Delete(id); err != ErrUnknownConstraint {
		t.Fatalf("err = %v, want ErrUnknownConstraint", err)
	}
}

func TestSelfLoopConflict(t *testing.T) {
	s := NewSystem(2)
	s.Add(0, 1, 4)                    // id 0
	_, conflict, _ := s.Add(1, 1, -1) // id 1: x1 - x1 <= -1, impossible
	if !reflect.DeepEqual(conflict, []int{1}) {
		t.Fatalf("conflict = %v, want [1]", conflict)
	}
	checkMinimalInfeasible(t, 2, s.Constraints(), conflict)
	if err := s.Delete(1); err != nil {
		t.Fatal(err)
	}
	checkPotentials(t, s)
}

func TestMaxConstraints(t *testing.T) {
	s := NewSystem(2)
	for i := 0; i < MaxConstraints; i++ {
		if _, _, err := s.Add(0, 1, int64(i)); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if _, _, err := s.Add(0, 1, 0); err != ErrTooManyConstraints {
		t.Fatalf("err = %v, want ErrTooManyConstraints", err)
	}
}

func TestRandomisedMinimality(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 60; trial++ {
		numVars := 2 + rng.Intn(4)
		s := NewSystem(numVars)
		var conflict []int
		var lastID int
		// Add constraints until the first conflict (or the cap).
		for len(s.Constraints()) < MaxConstraints {
			from := rng.Intn(numVars)
			to := rng.Intn(numVars)
			w := int64(rng.Intn(11) - 5)
			id, c, err := s.Add(from, to, w)
			if err != nil {
				t.Fatal(err)
			}
			lastID = id
			if c != nil {
				conflict = c
				break
			}
		}
		if conflict == nil {
			continue // stayed feasible; nothing to check
		}
		// The conflict must involve the last added constraint, because the
		// system was feasible before it.
		found := false
		for _, id := range conflict {
			if id == lastID {
				found = true
			}
		}
		if !found {
			t.Fatalf("trial %d: conflict %v lacks new constraint %d", trial, conflict, lastID)
		}
		checkMinimalInfeasible(t, numVars, s.Constraints(), conflict)

		// Deleting the freshly added constraint must restore the feasible
		// potentials, since the system was feasible before it.
		if err := s.Delete(lastID); err != nil {
			t.Fatal(err)
		}
		checkPotentials(t, s)
	}
}

func TestDeleteRestoresDerivedEdges(t *testing.T) {
	s := NewSystem(2)
	s.Add(0, 1, 7) // id 0
	s.Add(0, 1, 3) // id 1 (tighter)
	e, _ := s.Derived(0, 1)
	if e.Weight != 3 || !reflect.DeepEqual(e.Sources, []int{1}) {
		t.Fatalf("derived = %+v, want weight 3 sources [1]", e)
	}
	if err := s.Delete(1); err != nil {
		t.Fatal(err)
	}
	e, ok := s.Derived(0, 1)
	if !ok || e.Weight != 7 || !reflect.DeepEqual(e.Sources, []int{0}) {
		t.Fatalf("after delete derived = %+v ok=%v, want weight 7 sources [0]", e, ok)
	}
	checkPotentials(t, s)
}
