package workgroup

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
	"time"
)

// A wait edge that would close a cycle is rejected, and the returned
// evidence is the concrete cycle including the rejected edge.
func TestCycleDetection(t *testing.T) {
	g := NewGraph()
	for _, e := range [][2]string{{"a", "b"}, {"b", "c"}, {"c", "d"}} {
		if err := g.AddWait(e[0], e[1]); err != nil {
			t.Fatalf("AddWait(%s,%s): %v", e[0], e[1], err)
		}
	}

	err := g.AddWait("d", "a")
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("AddWait(d,a) = %v, want *CycleError", err)
	}
	want := []string{"d", "a", "b", "c", "d"}
	if !reflect.DeepEqual(cyc.Path, want) {
		t.Fatalf("cycle evidence = %v, want %v", cyc.Path, want)
	}

	// The rejected edge must not have been recorded.
	for _, e := range g.Edges() {
		if e == [2]string{"d", "a"} {
			t.Fatal("rejected edge was recorded")
		}
	}
}

// A self wait is a trivial cycle.
func TestSelfWaitCycle(t *testing.T) {
	g := NewGraph()
	err := g.AddWait("x", "x")
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("AddWait(x,x) = %v, want *CycleError", err)
	}
	if !reflect.DeepEqual(cyc.Path, []string{"x", "x"}) {
		t.Fatalf("cycle evidence = %v, want [x x]", cyc.Path)
	}
}

// WaitOn blocks until the target group fully closes, and the wait
// edge is visible in the graph.
func TestWaitOn(t *testing.T) {
	g := NewGraph()
	a, b := g.Group("a"), g.Group("b")
	if err := b.Add(); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- a.WaitOn(b) }()

	select {
	case <-done:
		t.Fatal("WaitOn returned before target closed")
	case <-time.After(20 * time.Millisecond):
	}

	b.Done()
	go b.Close()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("WaitOn: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("WaitOn did not return after target closed")
	}

	found := false
	for _, e := range g.Edges() {
		if e == [2]string{"a", "b"} {
			found = true
		}
	}
	if !found {
		t.Fatal("wait edge a->b not recorded")
	}
}

// A WaitOn that would create a cycle fails immediately instead of
// deadlocking.
func TestWaitOnCycleFailsFast(t *testing.T) {
	g := NewGraph()
	a, b := g.Group("a"), g.Group("b")
	if err := g.AddWait("a", "b"); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- b.WaitOn(a) }()
	select {
	case err := <-done:
		var cyc *CycleError
		if !errors.As(err, &cyc) {
			t.Fatalf("WaitOn = %v, want *CycleError", err)
		}
	case <-time.After(time.Second):
		t.Fatal("WaitOn blocked despite cycle")
	}
}

// Groups from different graphs cannot wait on each other.
func TestWaitOnDifferentGraphs(t *testing.T) {
	a := NewGraph().Group("a")
	b := NewGraph().Group("b")
	if err := a.WaitOn(b); err == nil {
		t.Fatal("WaitOn across graphs succeeded")
	}
}

// Every edge the graph accepts keeps it acyclic, and every edge it
// rejects would really close a cycle — cross-checked by the
// independent Checker, with the CycleError evidence validated against
// the recorded edges.
func TestGraphCheckerAgreement(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	g := NewGraph()
	chk := Checker{}
	names := []string{"a", "b", "c", "d", "e", "f", "g", "h"}

	for i := 0; i < 500; i++ {
		from := names[rng.Intn(len(names))]
		to := names[rng.Intn(len(names))]
		err := g.AddWait(from, to)
		edges := g.Edges()

		if err == nil {
			if !chk.Acyclic(edges) {
				t.Fatalf("graph accepted %s->%s but checker reports a cycle in %v", from, to, edges)
			}
			continue
		}

		var cyc *CycleError
		if !errors.As(err, &cyc) {
			t.Fatalf("error = %v, want *CycleError", err)
		}
		// The rejected edge really would close a cycle.
		withEdge := append(append([][2]string{}, edges...), [2]string{from, to})
		if chk.Acyclic(withEdge) {
			t.Fatalf("graph rejected %s->%s but checker finds no cycle", from, to)
		}
		// The evidence is a genuine closed walk in edges + rejected edge.
		assertValidCycle(t, cyc.Path, withEdge)
	}
}

func assertValidCycle(t *testing.T, path []string, edges [][2]string) {
	t.Helper()
	if len(path) < 2 {
		t.Fatalf("cycle path too short: %v", path)
	}
	if path[0] != path[len(path)-1] {
		t.Fatalf("cycle path %v does not close", path)
	}
	set := make(map[[2]string]bool, len(edges))
	for _, e := range edges {
		set[e] = true
	}
	for i := 0; i+1 < len(path); i++ {
		if !set[[2]string{path[i], path[i+1]}] {
			t.Fatalf("cycle path %v uses non-existent edge %s->%s", path, path[i], path[i+1])
		}
	}
}
