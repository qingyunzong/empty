package timer_test

import (
	"reflect"
	"testing"

	"timer"
)

func noop(*timer.Clock) {}

// fired returns the IDs and ticks of all EventFired entries, in log order.
func fired(c *timer.Clock) (ids []uint64, ticks []uint64) {
	for _, e := range c.Events() {
		if e.Kind == timer.EventFired {
			ids = append(ids, e.Timer)
			ticks = append(ticks, e.Tick)
		}
	}
	return ids, ticks
}

func mustPanic(t *testing.T, name string, fn func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatalf("%s: expected panic", name)
		}
	}()
	fn()
}

func TestFiresInDeadlineThenIDOrder(t *testing.T) {
	c := timer.New(16)
	c.Schedule(10, noop) // id 1
	c.Schedule(5, noop)  // id 2
	c.Schedule(10, noop) // id 3
	c.Schedule(10, noop) // id 4
	c.Schedule(1, noop)  // id 5

	n, exhausted := c.AdvanceTo(10)
	if n != 5 || exhausted {
		t.Fatalf("AdvanceTo fired=%d exhausted=%v, want 5, false", n, exhausted)
	}
	ids, ticks := fired(c)
	if want := []uint64{5, 2, 1, 3, 4}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("fired order = %v, want %v (deadline order, same tick by ID)", ids, want)
	}
	if want := []uint64{1, 5, 10, 10, 10}; !reflect.DeepEqual(ticks, want) {
		t.Fatalf("fired ticks = %v, want %v", ticks, want)
	}
	if c.Now() != 10 {
		t.Fatalf("Now = %d, want 10", c.Now())
	}
	if c.Pending() != 0 {
		t.Fatalf("Pending = %d, want 0", c.Pending())
	}
}

func TestRescheduleMovesDeadline(t *testing.T) {
	c := timer.New(16)
	h := c.Schedule(10, noop)
	if _, ok := c.Reschedule(h, 3); !ok {
		t.Fatal("Reschedule failed for live timer")
	}
	n, _ := c.AdvanceTo(5)
	if n != 1 {
		t.Fatalf("fired = %d, want 1 (rescheduled earlier)", n)
	}
	ids, ticks := fired(c)
	if len(ids) != 1 || ticks[0] != 3 {
		t.Fatalf("fired = %v@%v, want exactly one fire at tick 3", ids, ticks)
	}
}

func TestRescheduleLaterFiresOnce(t *testing.T) {
	c := timer.New(16)
	h := c.Schedule(5, noop)
	if _, ok := c.Reschedule(h, 9); !ok {
		t.Fatal("Reschedule failed for live timer")
	}
	if n, _ := c.AdvanceTo(7); n != 0 {
		t.Fatalf("fired = %d at tick 7, want 0 (moved to 9)", n)
	}
	if n, _ := c.AdvanceTo(9); n != 1 {
		t.Fatalf("fired = %d at tick 9, want 1", n)
	}
	ids, ticks := fired(c)
	if len(ids) != 1 || ticks[0] != 9 {
		t.Fatalf("fired = %v@%v, want exactly one fire at tick 9 (stale heap entry ignored)", ids, ticks)
	}
}

func TestCancelPreventsFiring(t *testing.T) {
	c := timer.New(16)
	h1 := c.Schedule(4, noop)
	h2 := c.Schedule(4, noop)
	if !c.Cancel(h1) {
		t.Fatal("Cancel failed for live timer")
	}
	if !c.Cancel(h2) {
		t.Fatal("Cancel failed for live timer")
	}
	if n, exhausted := c.AdvanceTo(10); n != 0 || exhausted {
		t.Fatalf("fired=%d exhausted=%v, want 0, false", n, exhausted)
	}
	if c.Pending() != 0 {
		t.Fatalf("Pending = %d, want 0", c.Pending())
	}
	if c.Now() != 10 {
		t.Fatalf("Now = %d, want 10", c.Now())
	}
}

func TestStaleGenerationOperationsAreNoops(t *testing.T) {
	c := timer.New(16)
	h := c.Schedule(8, noop) // generation 0
	h2, ok := c.Reschedule(h, 12)
	if !ok {
		t.Fatal("Reschedule failed for live timer")
	}
	if c.Cancel(h) {
		t.Fatal("Cancel with stale handle succeeded, want no-op")
	}
	if _, ok := c.Reschedule(h, 3); ok {
		t.Fatal("Reschedule with stale handle succeeded, want no-op")
	}
	if c.Cancel(timer.Handle{ID: h.ID, Generation: 99}) {
		t.Fatal("Cancel with unknown generation succeeded, want no-op")
	}
	if c.Pending() != 1 {
		t.Fatalf("Pending = %d, want 1 (stale ops must not affect the timer)", c.Pending())
	}
	if !c.Cancel(h2) {
		t.Fatal("Cancel with current handle failed")
	}
	if n, _ := c.AdvanceTo(20); n != 0 {
		t.Fatalf("fired = %d, want 0 after cancel", n)
	}
}

func TestOperationsOnFiredTimerAreNoops(t *testing.T) {
	c := timer.New(16)
	h := c.Schedule(2, noop)
	if n, _ := c.AdvanceTo(2); n != 1 {
		t.Fatalf("fired = %d, want 1", n)
	}
	if c.Cancel(h) {
		t.Fatal("Cancel on fired timer succeeded, want no-op")
	}
	if _, ok := c.Reschedule(h, 5); ok {
		t.Fatal("Reschedule on fired timer succeeded, want no-op")
	}
}

func TestCallbackReRegistrationJoinsEndOfRound(t *testing.T) {
	c := timer.New(16)
	c.Schedule(5, func(c *timer.Clock) { // id 1
		c.Schedule(c.Now(), noop) // id 4, due at the tick being processed
	})
	c.Schedule(5, noop) // id 2
	c.Schedule(5, noop) // id 3

	n, exhausted := c.AdvanceTo(5)
	if n != 4 || exhausted {
		t.Fatalf("fired=%d exhausted=%v, want 4, false (re-registered timer fires in same round)", n, exhausted)
	}
	ids, _ := fired(c)
	if want := []uint64{1, 2, 3, 4}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("fired order = %v, want %v (re-registered timer last in round)", ids, want)
	}
	if c.Now() != 5 {
		t.Fatalf("Now = %d, want 5", c.Now())
	}
}

func TestCallbackSchedulingFutureTickWithinWindow(t *testing.T) {
	c := timer.New(16)
	var seen []uint64
	c.Schedule(5, func(c *timer.Clock) {
		seen = append(seen, c.Now())
		c.Schedule(12, func(c *timer.Clock) { seen = append(seen, c.Now()) })
	})
	n, _ := c.AdvanceTo(20)
	if n != 2 {
		t.Fatalf("fired = %d, want 2", n)
	}
	if want := []uint64{5, 12}; !reflect.DeepEqual(seen, want) {
		t.Fatalf("callback Now observations = %v, want %v", seen, want)
	}
	if c.Now() != 20 {
		t.Fatalf("Now = %d, want 20 (settles at target after last due timer)", c.Now())
	}
}

func TestBudgetStopsInfiniteReRegistration(t *testing.T) {
	c := timer.New(3)
	var again timer.Callback
	again = func(c *timer.Clock) { c.Schedule(c.Now(), again) }
	c.Schedule(5, again)

	for round := 1; round <= 3; round++ {
		n, exhausted := c.AdvanceTo(5)
		if n != 3 || !exhausted {
			t.Fatalf("round %d: fired=%d exhausted=%v, want 3, true", round, n, exhausted)
		}
		if c.Now() != 5 {
			t.Fatalf("round %d: Now = %d, want 5 (clock holds at exhausted tick)", round, c.Now())
		}
		if c.Pending() != 1 {
			t.Fatalf("round %d: Pending = %d, want 1", round, c.Pending())
		}
	}
	ids, _ := fired(c)
	if len(ids) != 9 {
		t.Fatalf("total fired = %d, want 9 (3 rounds x budget 3)", len(ids))
	}
}

func TestBudgetNotHitWhenChainEnds(t *testing.T) {
	c := timer.New(10)
	remaining := 4
	var again timer.Callback
	again = func(c *timer.Clock) {
		if remaining > 0 {
			remaining--
			c.Schedule(c.Now(), again)
		}
	}
	c.Schedule(7, again)
	n, exhausted := c.AdvanceTo(7)
	if n != 5 || exhausted {
		t.Fatalf("fired=%d exhausted=%v, want 5, false", n, exhausted)
	}
	if c.Pending() != 0 {
		t.Fatalf("Pending = %d, want 0", c.Pending())
	}
}

func TestEventLogIsReference(t *testing.T) {
	c := timer.New(16)
	h1 := c.Schedule(10, noop)
	c.Schedule(4, noop)
	h3 := c.Schedule(10, noop)
	h1, ok := c.Reschedule(h1, 6)
	if !ok {
		t.Fatal("Reschedule failed")
	}
	if !c.Cancel(h3) {
		t.Fatal("Cancel failed")
	}
	n, exhausted := c.AdvanceTo(10)
	if n != 2 || exhausted {
		t.Fatalf("fired=%d exhausted=%v, want 2, false", n, exhausted)
	}
	_ = h1

	want := []timer.Event{
		{Tick: 0, Kind: timer.EventScheduled, Timer: 1, Deadline: 10},
		{Tick: 0, Kind: timer.EventScheduled, Timer: 2, Deadline: 4},
		{Tick: 0, Kind: timer.EventScheduled, Timer: 3, Deadline: 10},
		{Tick: 0, Kind: timer.EventRescheduled, Timer: 1, Deadline: 6},
		{Tick: 0, Kind: timer.EventCancelled, Timer: 3, Deadline: 10},
		{Tick: 4, Kind: timer.EventFired, Timer: 2, Deadline: 4},
		{Tick: 6, Kind: timer.EventFired, Timer: 1, Deadline: 6},
	}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("event log mismatch:\n got: %+v\nwant: %+v", got, want)
	}
}

func TestEventsReturnsCopy(t *testing.T) {
	c := timer.New(16)
	c.Schedule(1, noop)
	ev := c.Events()
	ev[0].Timer = 999
	if c.Events()[0].Timer == 999 {
		t.Fatal("Events exposes internal log; want a copy")
	}
}

func TestAdvanceAcrossIdleTicks(t *testing.T) {
	c := timer.New(16)
	n, exhausted := c.AdvanceTo(100)
	if n != 0 || exhausted {
		t.Fatalf("fired=%d exhausted=%v, want 0, false", n, exhausted)
	}
	if c.Now() != 100 {
		t.Fatalf("Now = %d, want 100", c.Now())
	}
}

func TestPanics(t *testing.T) {
	mustPanic(t, "zero budget", func() { timer.New(0) })
	mustPanic(t, "negative budget", func() { timer.New(-2) })
	mustPanic(t, "nil callback", func() { timer.New(1).Schedule(1, nil) })
	mustPanic(t, "backward advance", func() {
		c := timer.New(1)
		c.AdvanceTo(10)
		c.AdvanceTo(9)
	})
}
