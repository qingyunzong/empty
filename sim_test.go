package sim

import (
	"errors"
	"reflect"
	"testing"
)

// actions flattens the event log into "thread:action" strings.
func actions(s *Sim) []string {
	var out []string
	for _, e := range s.Events {
		out = append(out, string(rune('0'+e.Thread))+":"+e.Action)
	}
	return out
}

func runAll(t *testing.T, s *Sim) {
	t.Helper()
	if err := s.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !s.Done() {
		t.Fatal("Run returned without error but sim is not done")
	}
}

// TestPriorityInheritance is the classic L/M/H scenario: H blocks on L's
// mutex, L inherits H's priority and runs ahead of M.
func TestPriorityInheritance(t *testing.T) {
	l := NewThread(1, 1, 0, Lock(0), Unlock(0))
	m := NewThread(2, 5, 1, Lock(1), Unlock(1))
	h := NewThread(3, 9, 1, Lock(0), Unlock(0))
	s := New(l, m, h)

	step := func() {
		t.Helper()
		if _, err := s.Step(); err != nil {
			t.Fatalf("Step: %v", err)
		}
	}

	step() // t0: L locks m0
	step() // t1: H blocks on m0
	if got := s.Effective(1); got != 9 {
		t.Fatalf("after H blocks: L effective = %d, want 9 (inherited)", got)
	}
	step() // t2: L (eff 9) beats M (5), unlocks m0
	if got := s.Effective(1); got != 1 {
		t.Fatalf("after release: L effective = %d, want 1 (base restored)", got)
	}
	for !s.Done() {
		step()
	}

	want := []string{
		"1:lock m0",
		"3:block m0 (held by 1)",
		"1:unlock m0",
		"3:lock m0",
		"3:unlock m0",
		"2:lock m1",
		"2:unlock m1",
	}
	if got := actions(s); !reflect.DeepEqual(got, want) {
		t.Fatalf("schedule mismatch\ngot:  %v\nwant: %v", got, want)
	}
}

// TestTransitiveInheritance builds the wait chain A -> B -> C and checks
// that C inherits A's priority through B, and that releasing locks
// recomputes effective priorities back down.
func TestTransitiveInheritance(t *testing.T) {
	c := NewThread(3, 1, 0, Lock(2), Unlock(2))
	b := NewThread(2, 5, 1, Lock(1), Lock(2), Unlock(2), Unlock(1))
	a := NewThread(1, 9, 3, Lock(1), Unlock(1))
	s := New(a, b, c)

	step := func() {
		t.Helper()
		if _, err := s.Step(); err != nil {
			t.Fatalf("Step: %v", err)
		}
	}

	step() // t0: C locks m2
	step() // t1: B locks m1
	step() // t2: B blocks on m2 (held by C)
	if got := s.Effective(3); got != 5 {
		t.Fatalf("C effective = %d, want 5", got)
	}
	step() // t3: A blocks on m1 (held by B); chain A->B->C
	if got := s.Effective(2); got != 9 {
		t.Fatalf("B effective = %d, want 9 (transitive)", got)
	}
	if got := s.Effective(3); got != 9 {
		t.Fatalf("C effective = %d, want 9 (transitive)", got)
	}
	step() // t4: C (eff 9) unlocks m2 and finishes
	if got := s.Effective(3); got != 1 {
		t.Fatalf("after release: C effective = %d, want 1", got)
	}
	step() // t5: B locks m2
	step() // t6: B unlocks m2
	step() // t7: B unlocks m1 and finishes
	if got := s.Effective(2); got != 5 {
		t.Fatalf("after release: B effective = %d, want 5", got)
	}
	for !s.Done() {
		step()
	}

	want := []string{
		"3:lock m2",
		"2:lock m1",
		"2:block m2 (held by 3)",
		"1:block m1 (held by 2)",
		"3:unlock m2",
		"2:lock m2",
		"2:unlock m2",
		"2:unlock m1",
		"1:lock m1",
		"1:unlock m1",
	}
	if got := actions(s); !reflect.DeepEqual(got, want) {
		t.Fatalf("schedule mismatch\ngot:  %v\nwant: %v", got, want)
	}
}

// TestDeadlockReportsCycle checks that a wait cycle stops the simulator
// with a DeadlockError naming the cycle instead of continuing to schedule.
func TestDeadlockReportsCycle(t *testing.T) {
	// T2 arrives later with higher priority so each thread grabs its first
	// mutex before either requests the second one.
	t1 := NewThread(1, 5, 0, Lock(1), Lock(2), Unlock(2), Unlock(1))
	t2 := NewThread(2, 6, 1, Lock(2), Lock(1), Unlock(1), Unlock(2))
	s := New(t1, t2)

	err := s.Run()
	var dl *DeadlockError
	if !errors.As(err, &dl) {
		t.Fatalf("Run error = %v, want *DeadlockError", err)
	}
	if want := []int{1, 2}; !reflect.DeepEqual(dl.Cycle, want) {
		t.Fatalf("cycle = %v, want %v", dl.Cycle, want)
	}
	if s.Done() {
		t.Fatal("sim reported done despite deadlock")
	}
	// The simulator must not keep scheduling past the deadlock.
	tick, events := s.Tick(), len(s.Events)
	if _, err := s.Step(); err == nil {
		t.Fatal("Step after deadlock returned nil error")
	}
	if s.Tick() != tick || len(s.Events) != events {
		t.Fatal("simulator advanced after deadlock")
	}
}

// TestTieBreakByID checks that equal effective priorities pick the
// smallest thread ID.
func TestTieBreakByID(t *testing.T) {
	x := NewThread(7, 3, 0, Lock(0), Unlock(0))
	y := NewThread(3, 3, 0, Lock(1), Unlock(1))
	s := New(x, y)
	runAll(t, s)
	if got := s.Events[0].Thread; got != 3 {
		t.Fatalf("first scheduled thread = %d, want 3 (smaller ID)", got)
	}
	// Equal priorities keep picking the smaller ID, so thread 3 runs to
	// completion before thread 7 starts.
	want := []string{"3:lock m1", "3:unlock m1", "7:lock m0", "7:unlock m0"}
	if got := actions(s); !reflect.DeepEqual(got, want) {
		t.Fatalf("schedule mismatch\ngot:  %v\nwant: %v", got, want)
	}
}

// expectedEff independently recomputes the effective priority of thread id
// by walking every thread's wait chain (the full wait-for graph) and taking
// the max base priority that reaches id. It shares no code with the
// simulator's fixpoint recompute, so the test cross-checks the two.
func expectedEff(s *Sim, id int) int {
	eff := s.byID[id].BasePrio
	for _, w := range s.threads {
		visited := map[int]bool{}
		for cur := w; cur != nil && !visited[cur.ID]; {
			visited[cur.ID] = true
			if cur.ID == id && w.BasePrio > eff {
				eff = w.BasePrio
			}
			tgt := s.waitTarget(cur)
			if tgt < 0 {
				break
			}
			cur = s.byID[tgt]
		}
	}
	return eff
}

// TestFullGraphRecompute steps a chained scenario and, after every single
// tick, cross-checks every effective priority against an independent
// full-graph recomputation.
func TestFullGraphRecompute(t *testing.T) {
	c := NewThread(3, 1, 0, Lock(2), Unlock(2))
	b := NewThread(2, 5, 1, Lock(1), Lock(2), Unlock(2), Unlock(1))
	a := NewThread(1, 9, 3, Lock(1), Unlock(1))
	d := NewThread(4, 7, 2, Lock(3), Unlock(3)) // independent thread, no waits
	s := New(a, b, c, d)

	check := func() {
		t.Helper()
		for _, th := range s.threads {
			if got, want := s.Effective(th.ID), expectedEff(s, th.ID); got != want {
				t.Fatalf("tick %d: thread %d effective = %d, full-graph recompute says %d",
					s.Tick(), th.ID, got, want)
			}
		}
	}
	check()
	for !s.Done() {
		if _, err := s.Step(); err != nil {
			t.Fatalf("Step: %v", err)
		}
		check()
	}
}
