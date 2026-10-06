package boolexec

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

// spec is a plain-data AST used to derive both the instrumented tree and the
// independent reference evaluation.
type spec struct {
	kind     Kind
	id       string
	label    string
	children []*spec
	value    bool // leaf result
	errs     bool // leaf returns an error
	panics   bool // leaf panics
}

func genSpec(r *rand.Rand, ids *int, depth int) *spec {
	mkID := func() string { *ids++; return fmt.Sprintf("n%d", *ids) }
	if depth == 0 || r.Intn(100) < 35 {
		return &spec{
			kind:   Leaf,
			id:     mkID(),
			label:  fmt.Sprintf("leaf-%d", r.Intn(8)),
			value:  r.Intn(2) == 0,
			errs:   r.Intn(100) < 8,
			panics: r.Intn(100) < 6,
		}
	}
	switch r.Intn(3) {
	case 0:
		return &spec{kind: Not, id: mkID(), children: []*spec{genSpec(r, ids, depth-1)}}
	case 1, 2:
		n := 1 + r.Intn(4)
		kind := And
		if r.Intn(2) == 0 {
			kind = Or
		}
		s := &spec{kind: kind, id: mkID()}
		for i := 0; i < n; i++ {
			s.children = append(s.children, genSpec(r, ids, depth-1))
		}
		return s
	}
	return genSpec(r, ids, depth)
}

var errRefLeaf = errors.New("leaf error")

// refEval is the independent reference: plain recursive short-circuit
// evaluation that records node starts and leaf reads.
func refEval(s *spec, counts map[string]uint64, reads map[string]uint64) (val bool, err error) {
	counts[s.id]++
	if s.kind == Leaf {
		reads[s.id]++
	}
	defer func() {
		if s.kind == Leaf && s.panics {
			val, err = false, fmt.Errorf("panic:%s", s.id)
		}
	}()
	switch s.kind {
	case Leaf:
		if s.errs {
			return false, errRefLeaf
		}
		return s.value, nil
	case Not:
		v, err := refEval(s.children[0], counts, reads)
		if err != nil {
			return false, err
		}
		return !v, nil
	case And:
		for _, c := range s.children {
			v, err := refEval(c, counts, reads)
			if err != nil {
				return false, err
			}
			if !v {
				return false, nil
			}
		}
		return true, nil
	case Or:
		for _, c := range s.children {
			v, err := refEval(c, counts, reads)
			if err != nil {
				return false, err
			}
			if v {
				return true, nil
			}
		}
		return false, nil
	}
	panic("bad kind")
}

// build converts a spec into an instrumented Node tree whose leaves record
// read side effects into the shared map.
func build(s *spec, mu *sync.Mutex, reads map[string]uint64) *Node {
	n := &Node{ID: s.id, Kind: s.kind, Label: s.label}
	if s.kind == Leaf {
		n.Leaf = func(context.Context) (bool, error) {
			mu.Lock()
			reads[s.id]++
			mu.Unlock()
			if s.panics {
				panic(fmt.Sprintf("panic:%s", s.id))
			}
			if s.errs {
				return false, errRefLeaf
			}
			return s.value, nil
		}
		return n
	}
	for _, c := range s.children {
		n.Children = append(n.Children, build(c, mu, reads))
	}
	return n
}

func TestRandomASTsMatchReference(t *testing.T) {
	for seed := int64(0); seed < 400; seed++ {
		r := rand.New(rand.NewSource(seed))
		var ids int
		s := genSpec(r, &ids, 1+r.Intn(5))

		var mu sync.Mutex
		execReads := map[string]uint64{}
		root := build(s, &mu, execReads)
		e, err := NewExecutor(root)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		gotVal, gotErr := e.Eval(context.Background(), root)

		refCounts := map[string]uint64{}
		refReads := map[string]uint64{}
		wantVal, wantErr := refEval(s, refCounts, refReads)

		if (gotErr != nil) != (wantErr != nil) {
			t.Fatalf("seed %d: err mismatch got=%v want=%v", seed, gotErr, wantErr)
		}
		if wantErr == nil && gotVal != wantVal {
			t.Fatalf("seed %d: value mismatch got=%v want=%v", seed, gotVal, wantVal)
		}

		cov := e.Snapshot()
		for id, want := range refCounts {
			if cov.Count(id) != want {
				t.Fatalf("seed %d: node %s count got=%d want=%d", seed, id, cov.Count(id), want)
			}
		}
		for id, got := range cov.Counts {
			if refCounts[id] != got {
				t.Fatalf("seed %d: node %s count got=%d want=%d", seed, id, got, refCounts[id])
			}
		}
		// Leaf read side effects must match the reference exactly: the
		// executor must never touch the right side of a short-circuited
		// operator, not even for bookkeeping.
		for id, want := range refReads {
			if execReads[id] != want {
				t.Fatalf("seed %d: leaf %s reads got=%d want=%d", seed, id, execReads[id], want)
			}
		}
		for id, got := range execReads {
			if refReads[id] != got {
				t.Fatalf("seed %d: leaf %s reads got=%d want=%d", seed, id, got, refReads[id])
			}
		}
	}
}

func TestRandomASTsConcurrentEvalCounts(t *testing.T) {
	r := rand.New(rand.NewSource(99))
	var ids int
	s := genSpec(r, &ids, 5)
	// Strip errors/panics so every goroutine gets a clean result.
	var clean func(x *spec)
	clean = func(x *spec) {
		x.errs, x.panics = false, false
		for _, c := range x.children {
			clean(c)
		}
	}
	clean(s)

	var mu sync.Mutex
	reads := map[string]uint64{}
	root := build(s, &mu, reads)
	e := mustExec(t, root)

	const goroutines = 32
	const evals = 50
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < evals; i++ {
				if _, err := e.Eval(context.Background(), root); err != nil {
					t.Errorf("Eval: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()

	// Single-run reference counts scaled by total evaluations must equal the
	// executor's accumulated counts.
	refCounts := map[string]uint64{}
	if _, err := refEval(s, refCounts, map[string]uint64{}); err != nil {
		t.Fatalf("refEval: %v", err)
	}
	cov := e.Snapshot()
	total := uint64(goroutines * evals)
	for id, want := range refCounts {
		if cov.Count(id) != want*total {
			t.Fatalf("node %s: got %d, want %d", id, cov.Count(id), want*total)
		}
	}
}
