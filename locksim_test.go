package locksim

import (
	"errors"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func eff(t *testing.T, s *Simulator, id string) int {
	t.Helper()
	p, ok := s.Effective(id)
	if !ok {
		t.Fatalf("unknown task %q", id)
	}
	return p
}

// A high-priority waiter donates its priority to the lock holder.
func TestBasicDonation(t *testing.T) {
	s := New()
	must(t, s.AddTask("low", 1))
	must(t, s.AddTask("high", 9))
	must(t, s.AddLock("mu"))

	must(t, s.Request("low", "mu"))
	if got := eff(t, s, "low"); got != 1 {
		t.Fatalf("before contention: low eff = %d, want 1", got)
	}
	must(t, s.Request("high", "mu"))
	if got := eff(t, s, "low"); got != 9 {
		t.Fatalf("after contention: low eff = %d, want 9 (donation)", got)
	}
	if got := eff(t, s, "high"); got != 9 {
		t.Fatalf("high eff = %d, want 9", got)
	}
}

// Donation propagates transitively along a chain of holders:
// t3 waits on L2 (held by t2), t2 waits on L1 (held by t1), so the
// maximum priority flows all the way to t1.
func TestChainDonation(t *testing.T) {
	s := New()
	must(t, s.AddTask("t1", 1))
	must(t, s.AddTask("t2", 5))
	must(t, s.AddTask("t3", 9))
	must(t, s.AddLock("L1"))
	must(t, s.AddLock("L2"))

	must(t, s.Request("t1", "L1"))
	must(t, s.Request("t2", "L2"))
	must(t, s.Request("t2", "L1")) // t2 blocks on t1
	must(t, s.Request("t3", "L2")) // t3 blocks on t2

	for _, id := range []string{"t1", "t2", "t3"} {
		if got := eff(t, s, id); got != 9 {
			t.Fatalf("%s eff = %d, want 9 (chain donation)", id, got)
		}
	}
}

// Releasing a lock withdraws the donation that flowed through it: the
// old holder drops back to its base priority and the lock is handed off
// to the first waiter.
func TestReleaseWithdrawsDonation(t *testing.T) {
	s := New()
	must(t, s.AddTask("low", 1))
	must(t, s.AddTask("high", 9))
	must(t, s.AddLock("mu"))

	must(t, s.Request("low", "mu"))
	must(t, s.Request("high", "mu"))
	if got := eff(t, s, "low"); got != 9 {
		t.Fatalf("low eff = %d, want 9", got)
	}

	must(t, s.Release("low", "mu"))
	if got := eff(t, s, "low"); got != 1 {
		t.Fatalf("after release: low eff = %d, want 1 (donation withdrawn)", got)
	}
	if h, _ := s.Holder("mu"); h != "high" {
		t.Fatalf("holder after handoff = %q, want %q", h, "high")
	}
	if got := eff(t, s, "high"); got != 9 {
		t.Fatalf("high eff = %d, want 9", got)
	}
}

// With several waiters the holder receives the maximum of their
// priorities; as each waiter is handed the lock and releases it, the
// donation is recomputed from the remaining waiters.
func TestMultipleWaitersMaxDonation(t *testing.T) {
	s := New()
	must(t, s.AddTask("holder", 1))
	must(t, s.AddTask("w1", 3))
	must(t, s.AddTask("w2", 8))
	must(t, s.AddTask("w3", 5))
	must(t, s.AddLock("mu"))

	must(t, s.Request("holder", "mu"))
	must(t, s.Request("w1", "mu"))
	must(t, s.Request("w2", "mu"))
	must(t, s.Request("w3", "mu"))

	if got := eff(t, s, "holder"); got != 8 {
		t.Fatalf("holder eff = %d, want 8 (max of waiters)", got)
	}

	// Handoff is FIFO: w1 gets the lock; w2 (8) and w3 (5) still wait.
	must(t, s.Release("holder", "mu"))
	if got := eff(t, s, "holder"); got != 1 {
		t.Fatalf("old holder eff = %d, want 1", got)
	}
	if got := eff(t, s, "w1"); got != 8 {
		t.Fatalf("w1 eff = %d, want 8 (donated by w2)", got)
	}

	// w2 gets the lock; only w3 (5) remains.
	must(t, s.Release("w1", "mu"))
	if got := eff(t, s, "w1"); got != 3 {
		t.Fatalf("w1 eff after release = %d, want 3", got)
	}
	if got := eff(t, s, "w2"); got != 8 {
		t.Fatalf("w2 eff = %d, want 8", got)
	}

	// w3 gets the lock; no waiters remain, no donation at all.
	must(t, s.Release("w2", "mu"))
	if got := eff(t, s, "w3"); got != 5 {
		t.Fatalf("w3 eff = %d, want 5 (no waiters left)", got)
	}
	must(t, s.Release("w3", "mu"))
	if h, _ := s.Holder("mu"); h != "" {
		t.Fatalf("lock should be free, held by %q", h)
	}
}

// A request that closes a wait-for cycle returns a CycleError naming
// the cycle instead of looping forever, and the fixed-point
// recomputation still terminates with sensible priorities.
func TestDeadlockReturnsCycle(t *testing.T) {
	s := New()
	must(t, s.AddTask("a", 4))
	must(t, s.AddTask("b", 7))
	must(t, s.AddLock("La"))
	must(t, s.AddLock("Lb"))

	must(t, s.Request("a", "La"))
	must(t, s.Request("b", "Lb"))
	must(t, s.Request("a", "Lb")) // a waits on b

	err := s.Request("b", "La") // b waits on a: cycle
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("Request returned %v, want *CycleError", err)
	}
	got := append([]string{}, ce.Cycle...)
	sort.Strings(got)
	if !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("cycle = %v, want [a b]", got)
	}

	// Fixed point still converged: both tasks sit at the cycle max.
	if got := eff(t, s, "a"); got != 7 {
		t.Fatalf("a eff = %d, want 7", got)
	}
	if got := eff(t, s, "b"); got != 7 {
		t.Fatalf("b eff = %d, want 7", got)
	}
}

// A three-task cycle reports the full ring in wait order.
func TestThreeWayDeadlockCycle(t *testing.T) {
	s := New()
	for _, id := range []string{"x", "y", "z"} {
		must(t, s.AddTask(id, 1))
		must(t, s.AddLock("L"+id))
		must(t, s.Request(id, "L"+id))
	}
	must(t, s.Request("x", "Ly")) // x waits on y
	must(t, s.Request("y", "Lz")) // y waits on z
	err := s.Request("z", "Lx")   // z waits on x: cycle
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("Request returned %v, want *CycleError", err)
	}
	if !reflect.DeepEqual(ce.Cycle, []string{"z", "x", "y"}) {
		t.Fatalf("cycle = %v, want [z x y]", ce.Cycle)
	}
}

// Base-priority changes are events too: raising a waiter boosts the
// donation, lowering it (or lowering the holder) is reflected after
// recomputation.
func TestPriorityChangeEvents(t *testing.T) {
	s := New()
	must(t, s.AddTask("holder", 2))
	must(t, s.AddTask("waiter", 3))
	must(t, s.AddLock("mu"))

	must(t, s.Request("holder", "mu"))
	must(t, s.Request("waiter", "mu"))
	if got := eff(t, s, "holder"); got != 3 {
		t.Fatalf("holder eff = %d, want 3", got)
	}

	must(t, s.SetBasePriority("waiter", 10))
	if got := eff(t, s, "holder"); got != 10 {
		t.Fatalf("after raise: holder eff = %d, want 10", got)
	}

	must(t, s.SetBasePriority("waiter", 1))
	if got := eff(t, s, "holder"); got != 2 {
		t.Fatalf("after lower: holder eff = %d, want 2", got)
	}
}

// referenceEffective is an independent model of donation: eff[T] is the
// maximum base priority over all tasks that can reach T in the wait-for
// graph (including T itself). It is computed by walking edges directly,
// not by the simulator's fixed-point loop.
func referenceEffective(base map[string]int, edges map[string]string) map[string]int {
	eff := make(map[string]int, len(base))
	for src, b := range base {
		cur := src
		seen := map[string]bool{}
		for !seen[cur] {
			seen[cur] = true
			if b > eff[cur] {
				eff[cur] = b
			}
			next, ok := edges[cur]
			if !ok {
				break
			}
			cur = next
		}
	}
	return eff
}

// Drives random event sequences (request / release / priority change)
// and after every event checks the simulator's fixed-point result
// against the independent reference model, across arbitrary multiple
// waits and deadlocks.
func TestFixedPointMatchesReferenceModel(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	tasks := []string{"t0", "t1", "t2", "t3", "t4"}
	locks := []string{"l0", "l1", "l2"}

	for trial := 0; trial < 60; trial++ {
		s := New()
		base := make(map[string]int, len(tasks))
		for _, id := range tasks {
			b := rng.Intn(10)
			must(t, s.AddTask(id, b))
			base[id] = b
		}
		for _, id := range locks {
			must(t, s.AddLock(id))
		}

		for step := 0; step < 300; step++ {
			task := tasks[rng.Intn(len(tasks))]
			lock := locks[rng.Intn(len(locks))]
			switch rng.Intn(3) {
			case 0:
				_ = s.Request(task, lock) // errors (blocked, deadlock) keep state consistent
			case 1:
				_ = s.Release(task, lock) // error if not the holder
			case 2:
				p := rng.Intn(10)
				must(t, s.SetBasePriority(task, p))
				base[task] = p
			}

			ref := referenceEffective(base, s.WaitEdges())
			for _, id := range tasks {
				if got := eff(t, s, id); got != ref[id] {
					t.Fatalf("trial %d step %d: eff[%s] = %d, reference = %d (edges=%v base=%v)",
						trial, step, id, got, ref[id], s.WaitEdges(), base)
				}
			}
		}
	}
}
