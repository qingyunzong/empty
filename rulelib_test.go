package rulelib_test

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"rulelib"
)

// --- independent verification helpers (test-only reimplementation) ---

// feasibleIndep is an independent Bellman-Ford feasibility check used to
// verify the library's answers without sharing its implementation.
func feasibleIndep(numVars int, cs []rulelib.Constraint) bool {
	dist := make([]int64, numVars)
	for i := 0; i <= numVars; i++ {
		updated := false
		for _, c := range cs {
			if d := dist[c.From] + c.Weight; d < dist[c.To] {
				dist[c.To] = d
				updated = true
			}
		}
		if !updated {
			return true
		}
	}
	return false
}

// subsetsIndep enumerates every subset of cs via recursion and returns
// those that are infeasible, as sorted source-ID sets.
func subsetsIndep(numVars int, cs []rulelib.Constraint) [][]int {
	var infeasible [][]int
	var rec func(i int, picked []rulelib.Constraint)
	rec = func(i int, picked []rulelib.Constraint) {
		if i == len(cs) {
			if len(picked) == 0 {
				return
			}
			if !feasibleIndep(numVars, picked) {
				seen := map[int]bool{}
				var ids []int
				for _, c := range picked {
					if !seen[c.ID] {
						seen[c.ID] = true
						ids = append(ids, c.ID)
					}
				}
				sort.Ints(ids)
				infeasible = append(infeasible, ids)
			}
			return
		}
		rec(i+1, picked)
		rec(i+1, append(append([]rulelib.Constraint(nil), picked...), cs[i]))
	}
	rec(0, nil)
	return infeasible
}

// verifyMinimality independently checks that got is an infeasible set
// with the fewest distinct source IDs among all infeasible subsets of cs.
func verifyMinimality(t *testing.T, numVars int, cs []rulelib.Constraint, got []int) {
	t.Helper()
	if len(got) == 0 {
		t.Fatal("library returned empty infeasible set for infeasible system")
	}
	all := subsetsIndep(numVars, cs)
	minDistinct := 1 << 30
	foundGot := false
	for _, ids := range all {
		if len(ids) < minDistinct {
			minDistinct = len(ids)
		}
		if reflect.DeepEqual(ids, got) {
			foundGot = true
		}
	}
	if !foundGot {
		t.Fatalf("returned set %v is not an infeasible subset per independent enumeration", got)
	}
	if len(got) != minDistinct {
		t.Fatalf("returned set %v has %d sources, independent minimum is %d", got, len(got), minDistinct)
	}
	// Minimality: dropping any single source must restore feasibility.
	for _, drop := range got {
		var sub []rulelib.Constraint
		for _, c := range cs {
			inGot := false
			for _, id := range got {
				if c.ID == id && id != drop {
					inGot = true
				}
			}
			if inGot {
				sub = append(sub, c)
			}
		}
		if !feasibleIndep(numVars, sub) {
			t.Fatalf("set %v not minimal: still infeasible without source %d", got, drop)
		}
	}
}

func checkPotentials(t *testing.T, s *rulelib.System) {
	t.Helper()
	pot, ok := s.Potentials()
	if !ok {
		t.Fatal("expected feasible potentials")
	}
	for _, c := range s.Constraints() {
		if pot[c.To]-pot[c.From] > c.Weight {
			t.Fatalf("potentials violate constraint %+v: p[%d]=%d p[%d]=%d", c, c.To, pot[c.To], c.From, pot[c.From])
		}
	}
}

// --- tests ---

func TestFeasibleAddAndPotentials(t *testing.T) {
	s := rulelib.New(3)
	cs := []rulelib.Constraint{
		{ID: 1, From: 0, To: 1, Weight: 2},
		{ID: 2, From: 1, To: 2, Weight: 3},
		{ID: 3, From: 2, To: 0, Weight: 10},
	}
	for _, c := range cs {
		if iis, err := s.Add(c); err != nil || iis != nil {
			t.Fatalf("Add(%+v) = %v, %v; want feasible", c, iis, err)
		}
	}
	if !s.Feasible() {
		t.Fatal("system should be feasible")
	}
	checkPotentials(t, s)
}

func TestDerivedBoundBindsSources(t *testing.T) {
	s := rulelib.New(3)
	for _, c := range []rulelib.Constraint{
		{ID: 7, From: 0, To: 1, Weight: 2},
		{ID: 9, From: 1, To: 2, Weight: 3},
		{ID: 4, From: 0, To: 2, Weight: 10}, // loose, not part of tightest edge
	} {
		if _, err := s.Add(c); err != nil {
			t.Fatal(err)
		}
	}
	w, srcs, ok := s.DerivedBound(0, 2)
	if !ok {
		t.Fatal("expected derived edge 0 -> 2")
	}
	if w != 5 {
		t.Fatalf("derived weight = %d, want 5", w)
	}
	if !reflect.DeepEqual(srcs, []int{7, 9}) {
		t.Fatalf("derived sources = %v, want [7 9]", srcs)
	}
}

func TestNegativeCycleReturnsMinSourceSet(t *testing.T) {
	s := rulelib.New(3)
	base := []rulelib.Constraint{
		{ID: 1, From: 0, To: 1, Weight: 0}, // x1 <= x0
		{ID: 2, From: 1, To: 2, Weight: 0}, // x2 <= x1
		{ID: 3, From: 0, To: 2, Weight: 0}, // x2 <= x0 (direct, 1 source)
	}
	for _, c := range base {
		if iis, err := s.Add(c); err != nil || iis != nil {
			t.Fatalf("Add(%+v) = %v, %v; want feasible", c, iis, err)
		}
	}
	// x0 <= x2 - 1 closes two negative cycles:
	//   {1,2,4}: 0->1->2->0 weight -1
	//   {3,4}:   0->2->0   weight -1  (fewer sources)
	iis, err := s.Add(rulelib.Constraint{ID: 4, From: 2, To: 0, Weight: -1})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(iis, []int{3, 4}) {
		t.Fatalf("infeasible set = %v, want [3 4]", iis)
	}
	if s.Feasible() {
		t.Fatal("system should be infeasible after negative cycle")
	}
	verifyMinimality(t, 3, s.Constraints(), iis)
}

func TestSelfLoopNegativeCycle(t *testing.T) {
	s := rulelib.New(2)
	iis, err := s.Add(rulelib.Constraint{ID: 5, From: 0, To: 0, Weight: -1})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(iis, []int{5}) {
		t.Fatalf("infeasible set = %v, want [5]", iis)
	}
	verifyMinimality(t, 2, s.Constraints(), iis)
}

func TestDeleteRestoresFeasiblePotentials(t *testing.T) {
	s := rulelib.New(3)
	for _, c := range []rulelib.Constraint{
		{ID: 1, From: 0, To: 1, Weight: 1},
		{ID: 2, From: 1, To: 2, Weight: 1},
	} {
		if _, err := s.Add(c); err != nil {
			t.Fatal(err)
		}
	}
	iis, err := s.Add(rulelib.Constraint{ID: 3, From: 2, To: 0, Weight: -5})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(iis, []int{1, 2, 3}) {
		t.Fatalf("infeasible set = %v, want [1 2 3]", iis)
	}
	if s.Feasible() {
		t.Fatal("system should be infeasible")
	}
	if _, ok := s.Potentials(); ok {
		t.Fatal("infeasible system must not report potentials")
	}

	// Deleting the offending source restores feasible potentials.
	s.Delete(3)
	if !s.Feasible() {
		t.Fatal("system should be feasible after deleting source 3")
	}
	checkPotentials(t, s)

	// Re-add, then delete a base constraint instead; also feasible.
	if _, err := s.Add(rulelib.Constraint{ID: 3, From: 2, To: 0, Weight: -5}); err != nil {
		t.Fatal(err)
	}
	s.Delete(1)
	if !s.Feasible() {
		t.Fatal("system should be feasible after deleting source 1")
	}
	checkPotentials(t, s)
}

func TestDuplicateSourceIDsCountedOnce(t *testing.T) {
	s := rulelib.New(2)
	// Both edges share source 8; together they form a negative cycle
	// counting as 1 distinct source, not 2 constraints.
	if _, err := s.Add(rulelib.Constraint{ID: 8, From: 0, To: 1, Weight: -2}); err != nil {
		t.Fatal(err)
	}
	iis, err := s.Add(rulelib.Constraint{ID: 8, From: 1, To: 0, Weight: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(iis, []int{8}) {
		t.Fatalf("infeasible set = %v, want [8]", iis)
	}
	verifyMinimality(t, 2, s.Constraints(), iis)
}

func TestMaxConstraints(t *testing.T) {
	s := rulelib.New(2)
	for i := 0; i < rulelib.MaxConstraints; i++ {
		if _, err := s.Add(rulelib.Constraint{ID: i + 1, From: 0, To: 1, Weight: int64(i)}); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	if _, err := s.Add(rulelib.Constraint{ID: 99, From: 0, To: 1, Weight: 0}); err != rulelib.ErrTooManyConstraints {
		t.Fatalf("err = %v, want ErrTooManyConstraints", err)
	}
}

func TestRandomizedMinimalityAgainstEnumeration(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		rng := rand.New(rand.NewSource(seed))
		numVars := 4
		s := rulelib.New(numVars)
		var added []rulelib.Constraint
		for i := 1; i <= 12; i++ {
			c := rulelib.Constraint{
				ID:     i,
				From:   rng.Intn(numVars),
				To:     rng.Intn(numVars),
				Weight: int64(rng.Intn(7) - 3),
			}
			iis, err := s.Add(c)
			if err != nil {
				t.Fatal(err)
			}
			added = append(added, c)
			if iis == nil {
				continue
			}
			// Infeasible: independently verify the returned set.
			verifyMinimality(t, numVars, added, iis)
			// Deleting the reported sources must restore feasibility.
			s.Delete(iis...)
			if !s.Feasible() {
				t.Fatalf("seed %d: still infeasible after deleting %v", seed, iis)
			}
			checkPotentials(t, s)
			break
		}
	}
}
