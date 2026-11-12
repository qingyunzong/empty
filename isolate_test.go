package dataeng

import (
	"errors"
	"math/bits"
	"math/rand"
	"reflect"
	"testing"
)

func TestEmptyBatchNeedsNoProbe(t *testing.T) {
	indices, optimal, err := Isolate([]int(nil), nil, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if optimal != true {
		t.Fatalf("empty batch should be proven optimal")
	}
	if len(indices) != 0 {
		t.Fatalf("unexpected indices: %v", indices)
	}
}

func TestFullBatchAcceptedInOneProbe(t *testing.T) {
	rows := []string{"a", "b", "c", "d"}
	calls := 0
	indices, optimal, err := Isolate(rows, func(subset []string) (bool, error) {
		calls++
		if len(subset) != len(rows) {
			return false, errors.New("unexpected subset")
		}
		return true, nil
	}, 5)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(indices, []int{0, 1, 2, 3}) || !optimal {
		t.Fatalf("got %v, %v, want [0 1 2 3], true", indices, optimal)
	}
	if calls != 1 {
		t.Fatalf("got %d calls, want 1", calls)
	}
}

func TestPairwiseConflictsAgainstAllSubsets(t *testing.T) {
	for n := 1; n <= 5; n++ {
		for graph := 0; graph < 1<<(n*(n-1)/2); graph++ {
			edges := decodeEdges(n, graph)
			expected, expectedOptimal := bruteForcePairs(n, edges)
			calls := 0
			got, optimal, err := Isolate(n, func(subset []int) (bool, error) {
				calls++
				return pairAcceptable(n, subset, edges), nil
			}, 1<<n)
			if err != nil {
				t.Fatalf("n=%d graph=%d: %v", n, graph, err)
			}
			if !optimal || !expectedOptimal {
				t.Fatalf("n=%d graph=%d: optimal=%v calls=%d", n, graph, optimal, calls)
			}
			if !reflect.DeepEqual(got, expected) {
				t.Fatalf("n=%d graph=%d edges=%v: got %v, want %v", n, graph, edges, got, expected)
			}
		}
	}
}

func TestRandomPairwiseConflictsAgainstAllSubsets(t *testing.T) {
	rng := rand.New(rand.NewSource(145))
	for n := 6; n <= 9; n++ {
		for trial := 0; trial < 80; trial++ {
			edges := make([]edge, 0)
			for i := 0; i < n; i++ {
				for j := i + 1; j < n; j++ {
					if rng.Intn(100) < 35 {
						edges = append(edges, edge{i, j})
					}
				}
			}
			expected, _ := bruteForcePairs(n, edges)
			got, optimal, err := Isolate(n, func(subset []int) (bool, error) {
				return pairAcceptable(n, subset, edges), nil
			}, 1<<n)
			if err != nil {
				t.Fatalf("n=%d trial=%d: %v", n, trial, err)
			}
			if !optimal {
				t.Fatalf("n=%d trial=%d: optimality not closed", n, trial)
			}
			if !reflect.DeepEqual(got, expected) {
				t.Fatalf("n=%d trial=%d edges=%v: got %v, want %v", n, trial, edges, got, expected)
			}
		}
	}
}

func TestNonHereditaryOracleWithFullBudget(t *testing.T) {
	n := 5
	accepted := map[uint32]bool{
		0b00001: true,
		0b00110: true,
		0b11111: false,
		0b01000: false,
		0b01111: false,
	}
	probe := func(mask uint32) (bool, error) {
		if mask == 0 {
			return true, nil
		}
		return accepted[mask], nil
	}
	expected, _ := bruteForceArbitrary(n, probe)
	got, optimal, err := Isolate(n, probe, 1<<n)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !optimal {
		t.Fatalf("full budget should close optimality")
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("got %v, want %v", got, expected)
	}
}

func TestRandomArbitraryOraclesWithFullBudget(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for n := 1; n <= 6; n++ {
		for trial := 0; trial < 40; trial++ {
			truth := make([]bool, 1<<n)
			for mask := 1; mask < 1<<n; mask++ {
				truth[mask] = rng.Intn(2) == 0
			}
			truth[0] = true
			probe := func(mask uint32) (bool, error) {
				return truth[mask], nil
			}
			expected, _ := bruteForceArbitrary(n, probe)
			got, optimal, err := Isolate(n, probe, 1<<n)
			if err != nil {
				t.Fatalf("n=%d trial=%d: %v", n, trial, err)
			}
			if !optimal {
				t.Fatalf("n=%d trial=%d: optimality not closed", n, trial)
			}
			if !reflect.DeepEqual(got, expected) {
				t.Fatalf("n=%d trial=%d: got %v, want %v", n, trial, got, expected)
			}
		}
	}
}

func TestTripleConflicts(t *testing.T) {
	n := 7
	conflicts := [][3]int{{0, 2, 5}, {1, 3, 6}, {0, 1, 4}}
	probe := func(subset []int) (bool, error) {
		present := make([]bool, n)
		for _, index := range subset {
			present[index] = true
		}
		for _, c := range conflicts {
			if present[c[0]] && present[c[1]] && present[c[2]] {
				return false, nil
			}
		}
		return true, nil
	}
	expected, _ := bruteForceArbitrary(n, func(mask uint32) (bool, error) {
		return probe(indicesForMask(mask))
	})
	got, optimal, err := Isolate(n, probe, 1<<n)
	if err != nil || !optimal {
		t.Fatalf("optimal=%v err=%v", optimal, err)
	}
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("got %v, want %v", got, expected)
	}
}

func TestAlternateArgumentOrder(t *testing.T) {
	rows := []string{"a", "b"}
	calls := 0
	probe := func(subset []string) (bool, error) {
		calls++
		return true, nil
	}
	indices, optimal, err := Isolate(rows, 3, probe)
	if err != nil || !optimal || calls != 1 {
		t.Fatalf("indices=%v optimal=%v calls=%d err=%v", indices, optimal, calls, err)
	}
	if !reflect.DeepEqual(indices, []int{0, 1}) {
		t.Fatalf("got %v", indices)
	}
}

func TestBudgetInsufficientReturnsProvenAcceptable(t *testing.T) {
	n := 8
	calls := 0
	rows := make([]int, n)
	indices, optimal, err := Isolate(rows, func(subset []int) (bool, error) {
		calls++
		return false, nil
	}, 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calls != 1 {
		t.Fatalf("got %d calls, want 1", calls)
	}
	if optimal {
		t.Fatalf("optimality should remain open")
	}
	if len(indices) != 0 {
		t.Fatalf("empty subseries is the only proven choice, got %v", indices)
	}
}

func TestProbeErrorStops(t *testing.T) {
	sentinel := errors.New("write failed")
	calls := 0
	_, optimal, err := Isolate([]int{0, 1, 2}, func(subset []int) (bool, error) {
		calls++
		if len(subset) == 2 && subset[0] == 0 && subset[1] == 1 {
			return false, sentinel
		}
		return len(subset) == 0, nil
	}, 100)
	if err == nil || !errors.Is(err, sentinel) {
		t.Fatalf("got %v, want wrapped sentinel", err)
	}
	if optimal {
		t.Fatalf("error result must not claim optimality")
	}
	if calls > 100 {
		t.Fatalf("budget exceeded: %d", calls)
	}
}

func TestRowLimitAndValidation(t *testing.T) {
	rows := make([]int, MaxRows+1)
	called := false
	if _, _, err := Isolate(rows, func([]int) (bool, error) {
		called = true
		return true, nil
	}, 10); !errors.Is(err, ErrTooManyRows) {
		t.Fatalf("got %v, want ErrTooManyRows", err)
	}
	if called {
		t.Fatalf("probe called for rejected input")
	}
	if _, _, err := Isolate(rows[:1], func([]int) (bool, error) { return true, nil }, 0); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("got %v, want ErrInvalidBudget", err)
	}
}

func TestIndexAndMaskProbeForms(t *testing.T) {
	rows := []string{"x", "y", "z"}
	indicesWanted := []int{0, 2}
	indices, optimal, err := Isolate(rows, func(subset []int) (bool, error) {
		return reflect.DeepEqual(subset, indicesWanted) || len(subset) == 0, nil
	}, 1<<len(rows))
	if err != nil || !optimal {
		t.Fatalf("index form: got %v, %v", optimal, err)
	}
	if !reflect.DeepEqual(indices, indicesWanted) {
		t.Fatalf("index form: got %v, want %v", indices, indicesWanted)
	}

	acceptedMask := uint32(0b101)
	indices, optimal, err = Isolate(3, func(mask uint32) (bool, error) {
		return mask == acceptedMask || mask == 0, nil
	}, 1<<3)
	if err != nil || !optimal {
		t.Fatalf("mask form: got %v, %v", optimal, err)
	}
	if !reflect.DeepEqual(indices, []int{0, 2}) {
		t.Fatalf("mask form: got %v", indices)
	}
}

type edge struct {
	a, b int
}

func decodeEdges(n, encoded int) []edge {
	var edges []edge
	bit := 0
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if encoded&(1<<bit) != 0 {
				edges = append(edges, edge{i, j})
			}
			bit++
		}
	}
	return edges
}

func pairAcceptable(n int, subset []int, edges []edge) bool {
	present := make([]bool, n)
	for _, index := range subset {
		present[index] = true
	}
	for _, e := range edges {
		if present[e.a] && present[e.b] {
			return false
		}
	}
	return true
}

func bruteForcePairs(n int, edges []edge) ([]int, bool) {
	return bruteForceArbitrary(n, func(mask uint32) (bool, error) {
		return pairAcceptable(n, indicesForMask(mask), edges), nil
	})
}

func bruteForceArbitrary(n int, probe func(uint32) (bool, error)) ([]int, bool) {
	best := []int{}
	bestSize := 0
	for mask := uint32(0); mask < uint32(1<<n); mask++ {
		accepted, _ := probe(mask)
		if !accepted {
			continue
		}
		size := bits.OnesCount32(mask)
		indices := indicesForMask(mask)
		if size > bestSize || (size == bestSize && lexLess(indices, best)) {
			best = indices
			bestSize = size
		}
	}
	return best, true
}

func lexLess(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}
