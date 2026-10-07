package ratelimit

import "testing"

func mustReserve(t *testing.T, l *Limiter, cost, notBefore int64) *Reservation {
	t.Helper()
	r, ok := l.Reserve(cost, notBefore)
	if !ok {
		t.Fatalf("Reserve(%d, %d) failed, want ok", cost, notBefore)
	}
	return r
}

func TestExactRemainderRefill(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(10, 1, 2, clock) // 0.5 token per tick

	mustReserve(t, l, 10, 0) // drain the full bucket at tick 0
	l.Sync()

	clock.Advance(3) // 1.5 tokens refilled
	whole, rem := l.Balance()
	if whole != 1 || rem != 1 {
		t.Fatalf("Balance() = (%d, %d), want (1, 1) i.e. 1.5 tokens", whole, rem)
	}

	// 2 tokens are available exactly one tick later (2.0).
	r := mustReserve(t, l, 2, 0)
	if r.At != 4 {
		t.Fatalf("reservation scheduled at %d, want 4", r.At)
	}
	clock.Advance(1)
	if ex := l.Sync(); len(ex) != 1 || ex[0].Seq != r.Seq {
		t.Fatalf("Sync() executed %v, want reservation %d", ex, r.Seq)
	}
	whole, rem = l.Balance()
	if whole != 0 || rem != 0 {
		t.Fatalf("Balance() = (%d, %d), want (0, 0)", whole, rem)
	}
}

func TestSameTickReservationOrder(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(10, 0, 1, clock) // no refill

	a := mustReserve(t, l, 6, 5)
	b := mustReserve(t, l, 4, 5)
	if a.At != 5 || b.At != 5 {
		t.Fatalf("At = (%d, %d), want (5, 5)", a.At, b.At)
	}
	clock.Advance(5)
	ex := l.Sync()
	if len(ex) != 2 || ex[0].Seq != a.Seq || ex[1].Seq != b.Seq {
		t.Fatalf("execution order = %v, want seq %d then %d", ex, a.Seq, b.Seq)
	}
	if _, ok := l.Reserve(1, 0); ok {
		t.Fatal("Reserve(1) succeeded with empty bucket and zero rate, want failure")
	}
}

func TestCancelRepacksWithoutCrossingExecuted(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(10, 1, 1, clock)

	a := mustReserve(t, l, 10, 0) // executes at 0
	b := mustReserve(t, l, 8, 0)  // at 8
	c := mustReserve(t, l, 4, 0)  // at 12
	if b.At != 8 || c.At != 12 {
		t.Fatalf("At = (%d, %d), want (8, 12)", b.At, c.At)
	}

	// a executed lazily at tick 0 during the later Reserve calls.
	if l.Status(a) != Executed {
		t.Fatalf("a status = %v, want Executed", l.Status(a))
	}
	clock.Advance(5) // balance now 5

	refund, ok := l.Cancel(b)
	if !ok || refund != 8 {
		t.Fatalf("Cancel(b) = (%d, %v), want (8, true)", refund, ok)
	}
	// c re-packs to now=5 (balance 5 >= 4), never before the executed a.
	if c.At != 5 {
		t.Fatalf("c.At = %d, want 5", c.At)
	}
	if c.At < clock.Now() {
		t.Fatalf("c.At = %d moved before now = %d", c.At, clock.Now())
	}
}

func TestCancelRefundAndStatus(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(5, 1, 1, clock)

	a := mustReserve(t, l, 5, 0) // at 0
	b := mustReserve(t, l, 5, 0) // at 5
	c := mustReserve(t, l, 3, 0) // at 8

	refund, ok := l.Cancel(b)
	if !ok || refund != 5 {
		t.Fatalf("Cancel(b) = (%d, %v), want (5, true)", refund, ok)
	}
	if c.At != 3 { // b's 5 tokens freed: c needs 3, refilled by tick 3
		t.Fatalf("c.At = %d, want 3 after re-pack", c.At)
	}
	if l.Status(b) != Canceled {
		t.Fatalf("b status = %v, want Canceled", l.Status(b))
	}
	if _, ok := l.Cancel(b); ok {
		t.Fatal("second Cancel(b) succeeded, want failure")
	}
	l.Sync() // executes a at 0
	if _, ok := l.Cancel(a); ok {
		t.Fatal("Cancel on executed reservation succeeded, want failure")
	}
	foreign := &Reservation{Seq: 999}
	if _, ok := l.Cancel(foreign); ok {
		t.Fatal("Cancel on foreign reservation succeeded, want failure")
	}
	if _, ok := l.Cancel(nil); ok {
		t.Fatal("Cancel(nil) succeeded, want failure")
	}
}

func TestCapacityCapAndValidation(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(5, 10, 1, clock)

	clock.Advance(100) // refill far beyond capacity
	whole, rem := l.Balance()
	if whole != 5 || rem != 0 {
		t.Fatalf("Balance() = (%d, %d), want (5, 0): cap not enforced", whole, rem)
	}
	if _, ok := l.Reserve(6, 0); ok {
		t.Fatal("Reserve(6) with capacity 5 succeeded, want failure")
	}
	if _, ok := l.Reserve(0, 0); ok {
		t.Fatal("Reserve(0) succeeded, want failure")
	}
	if _, ok := l.Reserve(-3, 0); ok {
		t.Fatal("Reserve(-3) succeeded, want failure")
	}
}

func TestNotBeforeHonored(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(10, 1, 1, clock)

	r := mustReserve(t, l, 3, 20) // bucket is full, but notBefore dominates
	if r.At != 20 {
		t.Fatalf("At = %d, want 20", r.At)
	}
	// A later reservation with no notBefore still appends after it.
	s := mustReserve(t, l, 3, 0)
	if s.At != 20 {
		t.Fatalf("At = %d, want 20 (appended at same tick, later seq)", s.At)
	}
	ex := func() []Reservation { clock.Advance(20); return l.Sync() }()
	if len(ex) != 2 || ex[0].Seq != r.Seq || ex[1].Seq != s.Seq {
		t.Fatalf("execution = %v, want seq %d then %d at tick 20", ex, r.Seq, s.Seq)
	}
}

func TestZeroRateNeverSatisfiable(t *testing.T) {
	clock := NewManualClock(0)
	l := NewLimiter(4, 0, 1, clock)

	mustReserve(t, l, 4, 0)
	if _, ok := l.Reserve(1, 0); ok {
		t.Fatal("Reserve succeeded with zero rate and drained bucket, want failure")
	}
	clock.Advance(1000)
	if _, ok := l.Reserve(1, 0); ok {
		t.Fatal("Reserve succeeded after waiting with zero rate, want failure")
	}
}
