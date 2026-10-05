package ratelimit

import "testing"

func reserveTicks(t *testing.T, l *Limiter, costs ...int64) []int64 {
	t.Helper()
	ticks := make([]int64, len(costs))
	for i, c := range costs {
		r := l.Reserve(c)
		if r == nil {
			t.Fatalf("Reserve(%d) returned nil", c)
		}
		ticks[i] = r.Tick()
	}
	return ticks
}

func assertTicks(t *testing.T, got []int64, want []int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d reservations, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("reservation %d scheduled at tick %d, want %d (all: got %v want %v)", i, got[i], want[i], got, want)
		}
	}
}

// Fractional remainders must be carried exactly: with 2/3 token per tick
// the third reservation waits 2 ticks and leaves a 1/3-token remainder,
// so the fourth waits only 1 tick and the fifth waits 2 again.
func TestExactRemainderRefill(t *testing.T) {
	l := NewLimiter(2, 3, 2, NewClock(0))
	assertTicks(t, reserveTicks(t, l, 1, 1, 1, 1, 1), []int64{0, 0, 2, 3, 5})
}

// An integer-rate limiter behaves like a plain token bucket.
func TestIntegerRate(t *testing.T) {
	l := NewLimiter(1, 1, 4, NewClock(0))
	assertTicks(t, reserveTicks(t, l, 4, 4, 2), []int64{0, 4, 6})
}

// Reservations that all fit in the burst share one tick and keep their
// reservation order.
func TestSameTickReservationOrder(t *testing.T) {
	l := NewLimiter(1, 1, 10, NewClock(0))
	rs := make([]*Reservation, 5)
	for i := range rs {
		rs[i] = l.Reserve(2)
		if rs[i].Tick() != 0 {
			t.Fatalf("reservation %d at tick %d, want 0", i, rs[i].Tick())
		}
		if rs[i].seq != int64(i+1) {
			t.Fatalf("reservation %d has seq %d, want %d", i, rs[i].seq, i+1)
		}
	}
	for i := 1; i < len(rs); i++ {
		if rs[i-1].seq >= rs[i].seq {
			t.Fatalf("reservation order not preserved: seq %d then %d", rs[i-1].seq, rs[i].seq)
		}
	}
}

// Cancelling an unexecuted reservation refunds its cost and pulls the
// reservations behind it earlier.
func TestCancelRefundsAndRetimes(t *testing.T) {
	l := NewLimiter(1, 1, 4, NewClock(0))
	r1 := l.Reserve(4) // tick 0
	r2 := l.Reserve(4) // tick 4
	r3 := l.Reserve(2) // tick 6
	assertTicks(t, []int64{r1.Tick(), r2.Tick(), r3.Tick()}, []int64{0, 4, 6})

	if !r2.Cancel() {
		t.Fatal("cancel of pending reservation failed")
	}
	if got := r3.Tick(); got != 2 {
		t.Fatalf("after refund r3 at tick %d, want 2", got)
	}
	if r2.Cancel() {
		t.Fatal("double cancel reported success")
	}
	if got := r1.Tick(); got != 0 {
		t.Fatalf("executed reservation moved to tick %d", got)
	}
}

// A reservation whose tick has been reached is executed and can no
// longer be cancelled.
func TestCancelExecutedFails(t *testing.T) {
	clock := NewClock(0)
	l := NewLimiter(1, 1, 10, clock)
	r := l.Reserve(3)
	clock.Advance(5)
	if r.Cancel() {
		t.Fatal("cancel of executed reservation reported success")
	}
	if l.Cancel(r) {
		t.Fatal("limiter cancel of executed reservation reported success")
	}
}

// Re-timing after a cancel must not move a reservation ahead of already
// executed ones.
func TestRetimeNeverCrossesExecuted(t *testing.T) {
	clock := NewClock(0)
	l := NewLimiter(1, 1, 3, clock)
	r1 := l.Reserve(2) // tick 0
	r2 := l.Reserve(2) // tick 1
	r3 := l.Reserve(2) // tick 3
	r4 := l.Reserve(1) // tick 4
	clock.Advance(1)   // r1 and r2 are now executed
	if !r3.Cancel() {
		t.Fatal("cancel of pending reservation failed")
	}
	if got := r4.Tick(); got != 2 {
		t.Fatalf("r4 re-timed to tick %d, want 2", got)
	}
	if r4.Tick() <= r2.Tick() {
		t.Fatalf("r4 at tick %d crossed executed r2 at tick %d", r4.Tick(), r2.Tick())
	}
	assertTicks(t, []int64{r1.Tick(), r2.Tick()}, []int64{0, 1})
}

// Idle accumulation is capped at the burst size.
func TestBurstCap(t *testing.T) {
	clock := NewClock(0)
	l := NewLimiter(1, 1, 5, clock)
	clock.Advance(100)
	assertTicks(t, reserveTicks(t, l, 5, 1), []int64{100, 101})
}

func TestInvalidCost(t *testing.T) {
	l := NewLimiter(1, 1, 5, NewClock(0))
	if r := l.Reserve(0); r != nil {
		t.Fatal("Reserve(0) did not return nil")
	}
	if r := l.Reserve(-3); r != nil {
		t.Fatal("Reserve(-3) did not return nil")
	}
	if r := l.Reserve(6); r != nil {
		t.Fatal("Reserve(burst+1) did not return nil")
	}
}

func TestDelay(t *testing.T) {
	clock := NewClock(0)
	l := NewLimiter(1, 1, 2, clock)
	r := l.Reserve(2) // tick 0
	q := l.Reserve(2) // tick 2
	if d := q.Delay(); d != 2 {
		t.Fatalf("delay %d, want 2", d)
	}
	clock.Advance(3)
	if d := q.Delay(); d != 0 {
		t.Fatalf("delay after execution %d, want 0", d)
	}
	if d := r.Delay(); d != 0 {
		t.Fatalf("delay of executed reservation %d, want 0", d)
	}
}
