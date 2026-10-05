package prioritysim

import (
	"reflect"
	"testing"
)

// bruteForceEff is an independent full-graph recomputation used to
// cross-check Sim.recomputeAll: the effective priority of a thread is the
// maximum base priority among itself and every thread that can reach it in
// the wait-for graph (BFS over "blocked on owner" edges).
func bruteForceEff(s *Sim, id int) int {
	best := s.thread(id).Base
	for _, u := range s.threads {
		if u.ID == id {
			continue
		}
		visited := map[int]bool{u.ID: true}
		queue := []int{u.ID}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			w := s.thread(cur).waitingOn
			if w < 0 {
				continue
			}
			owner := s.mutexes[w].Owner
			if owner < 0 || visited[owner] {
				continue
			}
			visited[owner] = true
			if owner == id && u.Base > best {
				best = u.Base
			}
			queue = append(queue, owner)
		}
	}
	return best
}

// stepAndCheck runs one tick and cross-checks every effective priority
// against the brute-force full-graph recomputation.
func stepAndCheck(t *testing.T, s *Sim) bool {
	t.Helper()
	cont := s.Step()
	for _, th := range s.threads {
		if want := bruteForceEff(s, th.ID); th.Eff != want {
			t.Fatalf("tick %d: T%d Eff=%d, brute-force full-graph recompute says %d",
				s.Tick, th.ID, th.Eff, want)
		}
	}
	return cont
}

func runAndCheck(t *testing.T, s *Sim, maxTicks int) {
	t.Helper()
	for i := 0; i < maxTicks && stepAndCheck(t, s); i++ {
	}
}

func TestPriorityInheritance(t *testing.T) {
	s := New(1)
	s.AddThread(0, 1, 0, Lock(0), Work(4), Unlock(0)) // low, grabs M0 first
	s.AddThread(1, 5, 1, Lock(0), Work(1), Unlock(0)) // high, arrives at tick 1
	s.AddThread(2, 3, 2, Work(6))                     // medium, arrives at tick 2

	stepAndCheck(t, s) // tick 0: T0 locks M0
	stepAndCheck(t, s) // tick 1: T1 blocks on M0
	if got := s.thread(0).Eff; got != 5 {
		t.Fatalf("T0 should inherit 5 from blocked T1, got %d", got)
	}
	stepAndCheck(t, s) // tick 2
	if got := s.Choice[2]; got != 0 {
		t.Fatalf("tick 2: inherited T0 (eff 5) should beat T2 (eff 3), ran T%d", got)
	}
	for s.Choice[len(s.Choice)-1] == 0 && s.thread(0).waitingOn < 0 && !s.thread(0).done {
		stepAndCheck(t, s)
	}
	runAndCheck(t, s, 1000)
	if s.Deadlock != nil {
		t.Fatalf("unexpected deadlock %v", s.Deadlock)
	}
	if !s.allDone() {
		t.Fatal("all threads should be done")
	}
	if got := s.thread(0).Eff; got != 1 {
		t.Fatalf("after unlock T0 Eff should drop back to base 1, got %d", got)
	}
}

func TestTransitiveInheritance(t *testing.T) {
	s := New(2)
	s.AddThread(0, 9, 2, Lock(0))                                         // A: high, wants M0
	s.AddThread(1, 5, 1, Lock(0), Lock(1), Work(1), Unlock(1), Unlock(0)) // B: holds M0, wants M1
	s.AddThread(2, 1, 0, Lock(1), Work(3), Unlock(1))                     // C: low, holds M1
	s.AddThread(3, 7, 4, Work(10))                                        // D: bystander, base 7

	stepAndCheck(t, s) // tick 0: C locks M1
	stepAndCheck(t, s) // tick 1: B locks M0
	stepAndCheck(t, s) // tick 2: A blocks on M0 -> B inherits 9
	if got := s.thread(1).Eff; got != 9 {
		t.Fatalf("B should inherit 9 from A, got %d", got)
	}
	stepAndCheck(t, s) // tick 3: B blocks on M1 -> chain A->B->C
	if got := s.thread(2).Eff; got != 9 {
		t.Fatalf("C should transitively inherit 9 from A, got %d", got)
	}
	stepAndCheck(t, s) // tick 4: C (eff 9) must beat D (base 7)
	if got := s.Choice[4]; got != 2 {
		t.Fatalf("tick 4: inherited C (eff 9) should beat D (eff 7), ran T%d", got)
	}
	runAndCheck(t, s, 1000)
	if s.Deadlock != nil {
		t.Fatalf("unexpected deadlock %v", s.Deadlock)
	}
	if !s.allDone() {
		t.Fatal("all threads should be done")
	}
	for id, want := range map[int]int{0: 9, 1: 5, 2: 1, 3: 7} {
		if got := s.thread(id).Eff; got != want {
			t.Fatalf("after all locks released T%d Eff=%d, want base %d", id, got, want)
		}
	}
}

func TestUnlockRecomputesEffectivePriority(t *testing.T) {
	s := New(1)
	s.AddThread(0, 2, 0, Lock(0), Work(2), Unlock(0))
	s.AddThread(1, 8, 1, Lock(0), Unlock(0))

	stepAndCheck(t, s) // tick 0: T0 locks M0
	stepAndCheck(t, s) // tick 1: T1 blocks, T0 inherits 8
	if got := s.thread(0).Eff; got != 8 {
		t.Fatalf("T0 should inherit 8, got %d", got)
	}
	stepAndCheck(t, s) // tick 2: T0 works
	stepAndCheck(t, s) // tick 3: T0 works
	stepAndCheck(t, s) // tick 4: T0 unlocks -> recompute
	if got := s.thread(0).Eff; got != 2 {
		t.Fatalf("after unlock T0 Eff should be recomputed to base 2, got %d", got)
	}
	runAndCheck(t, s, 1000)
	if !s.allDone() || s.Deadlock != nil {
		t.Fatalf("want clean finish, done=%v deadlock=%v", s.allDone(), s.Deadlock)
	}
}

func TestDeadlockReportsCycle(t *testing.T) {
	s := New(2)
	s.AddThread(0, 1, 0, Lock(0), Lock(1), Unlock(1), Unlock(0))
	s.AddThread(1, 2, 1, Lock(1), Lock(0), Unlock(0), Unlock(1))

	stepAndCheck(t, s) // tick 0: T0 locks M0
	stepAndCheck(t, s) // tick 1: T1 locks M1
	stepAndCheck(t, s) // tick 2: T1 blocks on M0
	if s.Deadlock != nil {
		t.Fatalf("no deadlock yet, got %v", s.Deadlock)
	}
	stepAndCheck(t, s) // tick 3: T0 blocks on M1 -> cycle
	want := []int{0, 1}
	if !reflect.DeepEqual(s.Deadlock, want) {
		t.Fatalf("deadlock cycle = %v, want %v", s.Deadlock, want)
	}
	ticksAtDeadlock := s.Tick
	if s.Step() {
		t.Fatal("simulator must stop after reporting a deadlock, not keep scheduling")
	}
	if s.Tick != ticksAtDeadlock {
		t.Fatalf("tick advanced after deadlock: %d -> %d", ticksAtDeadlock, s.Tick)
	}
}

func TestSelfDeadlock(t *testing.T) {
	s := New(1)
	s.AddThread(0, 1, 0, Lock(0), Lock(0))
	stepAndCheck(t, s)
	stepAndCheck(t, s)
	if !reflect.DeepEqual(s.Deadlock, []int{0}) {
		t.Fatalf("self deadlock = %v, want [0]", s.Deadlock)
	}
}

func TestTieBreakBySmallerID(t *testing.T) {
	s := New(0)
	s.AddThread(1, 5, 0, Work(1))
	s.AddThread(0, 5, 0, Work(1))
	s.AddThread(2, 5, 0, Work(1))
	runAndCheck(t, s, 100)
	want := []int{0, 1, 2}
	if !reflect.DeepEqual(s.Choice, want) {
		t.Fatalf("equal priorities must run in id order %v, got %v", want, s.Choice)
	}
}
