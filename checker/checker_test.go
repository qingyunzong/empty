package checker

import (
	"math/rand"
	"testing"
)

func enq(id int, val int, call, ret int64) Op {
	return Op{ID: id, Kind: Enqueue, Val: val, Call: call, Ret: ret}
}

func penq(id int, val int, call int64) Op {
	return Op{ID: id, Kind: Enqueue, Val: val, Call: call, Pending: true}
}

func deq(id int, val int, call, ret int64) Op {
	return Op{ID: id, Kind: Dequeue, Val: val, Call: call, Ret: ret}
}

func deqEmpty(id int, call, ret int64) Op {
	return Op{ID: id, Kind: Dequeue, Empty: true, Call: call, Ret: ret}
}

func pdeq(id int, call int64) Op {
	return Op{ID: id, Kind: Dequeue, Call: call, Pending: true}
}

// agree runs both engines, demands the same verdict, and validates any
// witness independently.
func agree(t *testing.T, ops []Op) bool {
	t.Helper()
	wit, ok := Solve(ops)
	bwit, bok := BruteForce(ops)
	if ok != bok {
		t.Fatalf("verdict mismatch: Solve=%v BruteForce=%v\nops=%v", ok, bok, ops)
	}
	if ok {
		if err := Validate(wit); err != nil {
			t.Fatalf("Solve produced invalid witness: %v\nops=%v", err, ops)
		}
		if err := Validate(bwit); err != nil {
			t.Fatalf("BruteForce produced invalid witness: %v\nops=%v", err, ops)
		}
	}
	return ok
}

func TestFeasibleSequential(t *testing.T) {
	ops := []Op{
		enq(1, 1, 0, 2),
		enq(2, 2, 3, 4),
		deq(3, 1, 5, 6),
		deq(4, 2, 7, 8),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestFeasibleOverlapReordered(t *testing.T) {
	// enq(2) is invoked first but returns last; the serial explanation
	// must place enq(1) before enq(2) so that deq observes 1 at the head.
	ops := []Op{
		enq(1, 2, 0, 5),
		enq(2, 1, 1, 2),
		deq(3, 1, 3, 4),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestInfeasibleRealTime(t *testing.T) {
	// deq returns 1 before enq(1) is even invoked.
	ops := []Op{
		deq(1, 1, 0, 1),
		enq(2, 1, 2, 3),
	}
	if agree(t, ops) {
		t.Fatal("expected infeasible")
	}
}

func TestInfeasibleFIFO(t *testing.T) {
	// 1 was enqueued before 2 (disjoint intervals), so deq cannot yield 2.
	ops := []Op{
		enq(1, 1, 0, 1),
		enq(2, 2, 2, 3),
		deq(3, 2, 4, 5),
	}
	if agree(t, ops) {
		t.Fatal("expected infeasible")
	}
}

func TestFeasibleFIFOOverlap(t *testing.T) {
	// Enqueues overlap, so either serial order is allowed.
	ops := []Op{
		enq(1, 1, 0, 3),
		enq(2, 2, 1, 4),
		deq(3, 2, 5, 6),
		deq(4, 1, 7, 8),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestEmptyDequeue(t *testing.T) {
	ops := []Op{
		deqEmpty(1, 0, 1),
		enq(2, 7, 2, 3),
		deq(3, 7, 4, 5),
		deqEmpty(4, 6, 7),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestInfeasibleEmptyDequeue(t *testing.T) {
	// enq(1) completes before the dequeue starts, so it cannot be empty.
	ops := []Op{
		enq(1, 1, 0, 1),
		deqEmpty(2, 2, 3),
	}
	if agree(t, ops) {
		t.Fatal("expected infeasible")
	}
}

func TestPendingEnqueueCompleted(t *testing.T) {
	// Only the pending enqueue can supply the value 1.
	ops := []Op{
		penq(1, 1, 0),
		deq(2, 1, 1, 2),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible via completing the pending enqueue")
	}
}

func TestPendingDequeueOmitted(t *testing.T) {
	// The pending dequeue must not consume the 1 before deq #3 runs.
	ops := []Op{
		enq(1, 1, 0, 1),
		pdeq(2, 2),
		deq(3, 1, 3, 4),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestPendingDequeueCompleted(t *testing.T) {
	// Pending dequeue can be completed as returning the enqueued value.
	ops := []Op{
		enq(1, 1, 0, 1),
		pdeq(2, 2),
		deqEmpty(3, 3, 4),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestTwelveFeasible(t *testing.T) {
	ops := []Op{
		enq(1, 1, 0, 1), enq(2, 2, 1, 2), enq(3, 3, 2, 3),
		enq(4, 4, 3, 4), enq(5, 5, 4, 5), enq(6, 6, 5, 6),
		deq(7, 1, 6, 7), deq(8, 2, 7, 8), deq(9, 3, 8, 9),
		deq(10, 4, 9, 10), deq(11, 5, 10, 11), deq(12, 6, 11, 12),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestTwelveInfeasible(t *testing.T) {
	// Six ordered enqueues, then a dequeue of the wrong head value.
	ops := []Op{
		enq(1, 1, 0, 1), enq(2, 2, 1, 2), enq(3, 3, 2, 3),
		enq(4, 4, 3, 4), enq(5, 5, 4, 5), enq(6, 6, 5, 6),
		deq(7, 6, 6, 7), deq(8, 1, 7, 8), deq(9, 2, 8, 9),
		deq(10, 3, 9, 10), deq(11, 4, 10, 11), deq(12, 5, 11, 12),
	}
	if agree(t, ops) {
		t.Fatal("expected infeasible")
	}
}

func TestTwelveConcurrentPending(t *testing.T) {
	// All twelve operations overlap; several are pending.
	ops := []Op{
		enq(1, 1, 0, 9), enq(2, 2, 0, 9), enq(3, 3, 0, 9),
		penq(4, 4, 0), pdeq(5, 0),
		deq(6, 1, 1, 8), deq(7, 2, 1, 8), deq(8, 3, 1, 8),
		enq(9, 5, 2, 7), deq(10, 4, 3, 6), deq(11, 5, 3, 6),
		deqEmpty(12, 4, 5),
	}
	if !agree(t, ops) {
		t.Fatal("expected feasible")
	}
}

func TestValidateRejectsBadOrder(t *testing.T) {
	ops := []Op{enq(1, 1, 0, 1), enq(2, 2, 2, 3), deq(3, 2, 4, 5)}
	if err := Validate(ops); err == nil {
		t.Fatal("expected Validate to reject FIFO violation")
	}
}

func TestValidateRejectsRealTime(t *testing.T) {
	ops := []Op{deq(1, 1, 0, 1), enq(2, 1, 2, 3)}
	if err := Validate(ops); err == nil {
		t.Fatal("expected Validate to reject real-time violation")
	}
}

// TestRandomCrossCheck compares the memoized solver against the independent
// brute-force enumeration on random histories of up to 9 operations.
func TestRandomCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 5000; trial++ {
		n := 2 + rng.Intn(8) // 2..9 operations
		ops := make([]Op, n)
		for i := range ops {
			call := int64(rng.Intn(2 * n))
			o := Op{ID: i + 1, Call: call}
			if rng.Intn(2) == 0 {
				o.Kind = Enqueue
				o.Val = rng.Intn(3)
			} else {
				o.Kind = Dequeue
				if rng.Intn(4) == 0 {
					o.Empty = true
				} else {
					o.Val = rng.Intn(3)
				}
			}
			if rng.Intn(5) == 0 {
				o.Pending = true
			} else {
				o.Ret = call + int64(rng.Intn(3))
			}
			ops[i] = o
		}
		agree(t, ops)
	}
}
