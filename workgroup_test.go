package workgroup

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"workgroup/checker"
)

func mustGroup(t *testing.T, env *Environment, name string) *Group {
	t.Helper()
	g, err := env.NewGroup(name)
	if err != nil {
		t.Fatalf("NewGroup(%q): %v", name, err)
	}
	return g
}

func TestShutdownFreezesThenWaits(t *testing.T) {
	env := NewEnvironment()
	g := mustGroup(t, env, "g")

	release := make(chan struct{})
	started := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		if !g.Go(func() { started <- struct{}{}; <-release }) {
			t.Fatal("Go rejected before Shutdown")
		}
	}
	<-started
	<-started

	done := make(chan struct{})
	go func() { g.Shutdown(); close(done) }()

	// Shutdown must freeze first: new tasks are rejected while it waits.
	deadline := time.After(2 * time.Second)
	for !g.Frozen() {
		select {
		case <-deadline:
			t.Fatal("Shutdown did not freeze the group")
		default:
		}
	}
	if g.Go(func() {}) {
		t.Fatal("Go accepted after freeze")
	}

	select {
	case <-done:
		t.Fatal("Shutdown returned before members exited")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not return after members exited")
	}
}

// Tasks are created concurrently with Shutdown; every accepted task must be
// accounted for by the time Shutdown returns.
func TestGoShutdownInterleave(t *testing.T) {
	for iter := 0; iter < 200; iter++ {
		env := NewEnvironment()
		g := mustGroup(t, env, "g")

		var accepted, completed atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					ok := g.Go(func() { completed.Add(1) })
					if !ok {
						return
					}
					accepted.Add(1)
				}
			}()
		}
		g.Shutdown()
		wg.Wait()
		if got, want := completed.Load(), accepted.Load(); got != want {
			t.Fatalf("iter %d: completed %d tasks but accepted %d", iter, got, want)
		}
	}
}

func TestDependsOnCycleEvidence(t *testing.T) {
	env := NewEnvironment()
	a := mustGroup(t, env, "a")
	b := mustGroup(t, env, "b")
	c := mustGroup(t, env, "c")

	if err := a.DependsOn(b); err != nil {
		t.Fatalf("a->b: %v", err)
	}
	if err := b.DependsOn(c); err != nil {
		t.Fatalf("b->c: %v", err)
	}
	if err := a.DependsOn(b); err != nil {
		t.Fatalf("duplicate edge a->b should be a no-op: %v", err)
	}

	err := c.DependsOn(a)
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("c->a: expected *CycleError, got %v", err)
	}
	want := []string{"c", "a", "b", "c"}
	if len(cyc.Path) != len(want) {
		t.Fatalf("cycle path = %v, want %v", cyc.Path, want)
	}
	for i := range want {
		if cyc.Path[i] != want[i] {
			t.Fatalf("cycle path = %v, want %v", cyc.Path, want)
		}
	}

	err = a.DependsOn(a)
	if !errors.As(err, &cyc) || len(cyc.Path) != 2 || cyc.Path[0] != "a" || cyc.Path[1] != "a" {
		t.Fatalf("self edge: got %v", err)
	}
}

func TestDependsOnAcrossEnvironments(t *testing.T) {
	a := mustGroup(t, NewEnvironment(), "a")
	b := mustGroup(t, NewEnvironment(), "b")
	if err := a.DependsOn(b); err == nil {
		t.Fatal("expected error for cross-environment edge")
	}
}

func TestWaitOnBlocksUntilOtherDrains(t *testing.T) {
	env := NewEnvironment()
	worker := mustGroup(t, env, "worker")
	waiter := mustGroup(t, env, "waiter")

	workerDone := make(chan struct{})
	worker.Go(func() {
		time.Sleep(50 * time.Millisecond)
		close(workerDone)
	})

	observed := make(chan bool, 1)
	waiter.Go(func() {
		if err := waiter.WaitOn(worker); err != nil {
			t.Errorf("WaitOn: %v", err)
		}
		select {
		case <-workerDone:
			observed <- true
		default:
			observed <- false
		}
	})

	waiter.Shutdown()
	worker.Shutdown()
	if !<-observed {
		t.Fatal("WaitOn returned before the other group drained")
	}
}

// Every accepted edge keeps the graph a DAG according to the independent
// checker, and every rejected edge would have created a cycle in it.
func TestSnapshotCrossCheckedByChecker(t *testing.T) {
	env := NewEnvironment()
	names := []string{"g0", "g1", "g2", "g3", "g4", "g5"}
	groups := make(map[string]*Group, len(names))
	for _, n := range names {
		groups[n] = mustGroup(t, env, n)
	}

	toEdges := func(pairs [][2]string) []checker.Edge {
		out := make([]checker.Edge, 0, len(pairs))
		for _, p := range pairs {
			out = append(out, checker.Edge{From: p[0], To: p[1]})
		}
		return out
	}

	// Deterministic pseudo-random edge order (xorshift).
	seed := uint32(0x9e3779b9)
	next := func() uint32 {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		return seed
	}

	attempts := 0
	for attempts < 60 {
		attempts++
		i, j := int(next()%uint32(len(names))), int(next()%uint32(len(names)))
		if i == j {
			continue
		}
		from, to := groups[names[i]], groups[names[j]]
		err := from.DependsOn(to)

		nodes, pairs := env.Snapshot()
		if err == nil {
			if cerr := checker.Check(nodes, toEdges(pairs)); cerr != nil {
				t.Fatalf("accepted edge %s->%s but checker rejects graph: %v", from.Name(), to.Name(), cerr)
			}
			continue
		}

		var cyc *CycleError
		if !errors.As(err, &cyc) {
			t.Fatalf("unexpected error for %s->%s: %v", from.Name(), to.Name(), err)
		}
		// The evidence must be a real cycle: the new edge followed by
		// existing edges, returning to the start.
		if len(cyc.Path) < 2 || cyc.Path[0] != from.Name() || cyc.Path[len(cyc.Path)-1] != from.Name() {
			t.Fatalf("bad cycle evidence for %s->%s: %v", from.Name(), to.Name(), cyc.Path)
		}
		if cyc.Path[1] != to.Name() {
			t.Fatalf("evidence %v does not start with the rejected edge %s->%s", cyc.Path, from.Name(), to.Name())
		}
		have := make(map[[2]string]bool, len(pairs))
		for _, p := range pairs {
			have[p] = true
		}
		for k := 1; k+1 < len(cyc.Path); k++ {
			if !have[[2]string{cyc.Path[k], cyc.Path[k+1]}] {
				t.Fatalf("evidence %v uses non-existent edge %s->%s", cyc.Path, cyc.Path[k], cyc.Path[k+1])
			}
		}
		// Adding the rejected edge must make the checker report a cycle.
		withNew := append(toEdges(pairs), checker.Edge{From: from.Name(), To: to.Name()})
		var checkerCyc *checker.CycleError
		if cerr := checker.Check(nodes, withNew); !errors.As(cerr, &checkerCyc) {
			t.Fatalf("checker should reject graph with %s->%s added, got %v", from.Name(), to.Name(), cerr)
		}
	}
	if attempts == 0 {
		t.Fatal("no edges attempted")
	}
}
