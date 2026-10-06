package timer

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func firedIDs(c *Clock) []int {
	events := c.Events()
	ids := make([]int, len(events))
	for i, e := range events {
		ids[i] = e.ID
	}
	return ids
}

func TestFiresInDeadlineOrder(t *testing.T) {
	c := NewClock(100)
	c.Schedule(10, func() {})
	c.Schedule(3, func() {})
	c.Schedule(7, func() {})
	if err := c.AdvanceTo(10); err != nil {
		t.Fatal(err)
	}
	want := []Event{{Tick: 3, ID: 1}, {Tick: 7, ID: 2}, {Tick: 10, ID: 0}}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestSameTickFiresInIDOrder(t *testing.T) {
	c := NewClock(100)
	for i := 0; i < 5; i++ {
		c.Schedule(4, func() {})
	}
	if err := c.Advance(4); err != nil {
		t.Fatal(err)
	}
	if got, want := firedIDs(c), []int{0, 1, 2, 3, 4}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fired IDs = %v, want %v", got, want)
	}
}

func TestRescheduleChangesDeadline(t *testing.T) {
	c := NewClock(100)
	h := c.Schedule(10, func() {})
	h, ok := c.Reschedule(h, 2)
	if !ok {
		t.Fatal("Reschedule on fresh handle failed")
	}
	if err := c.Advance(2); err != nil {
		t.Fatal(err)
	}
	want := []Event{{Tick: 2, ID: h.ID()}}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	if c.Pending() != 0 {
		t.Fatalf("pending = %d, want 0", c.Pending())
	}
}

func TestStaleGenerationOperationsAreNoops(t *testing.T) {
	c := NewClock(100)
	stale := c.Schedule(5, func() {})
	fresh, ok := c.Reschedule(stale, 8)
	if !ok {
		t.Fatal("Reschedule on fresh handle failed")
	}
	if _, ok := c.Reschedule(stale, 1); ok {
		t.Fatal("Reschedule on stale handle succeeded")
	}
	if c.Cancel(stale) {
		t.Fatal("Cancel on stale handle succeeded")
	}
	// The fresh generation is still alive and fires at the new deadline.
	if err := c.AdvanceTo(8); err != nil {
		t.Fatal(err)
	}
	want := []Event{{Tick: 8, ID: fresh.ID()}}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestCancel(t *testing.T) {
	c := NewClock(100)
	h := c.Schedule(5, func() {})
	if !c.Cancel(h) {
		t.Fatal("Cancel on fresh handle failed")
	}
	if c.Cancel(h) {
		t.Fatal("Cancel on cancelled handle succeeded")
	}
	if err := c.AdvanceTo(10); err != nil {
		t.Fatal(err)
	}
	if got := c.Events(); len(got) != 0 {
		t.Fatalf("events = %v, want none", got)
	}
	if c.Pending() != 0 {
		t.Fatalf("pending = %d, want 0", c.Pending())
	}
}

func TestReregistrationAtCurrentTickAppendsToRound(t *testing.T) {
	c := NewClock(100)
	var reregistered Timer
	// Timer 0 schedules a zero-delay timer from inside its callback.
	c.Schedule(5, func() {
		reregistered = c.Schedule(0, func() {})
	})
	// Timer 1 already exists at the same tick.
	c.Schedule(5, func() {})
	if err := c.AdvanceTo(5); err != nil {
		t.Fatal(err)
	}
	// The new timer (ID 2) fires at the end of the same round.
	want := []Event{{Tick: 5, ID: 0}, {Tick: 5, ID: 1}, {Tick: 5, ID: reregistered.ID()}}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	if got := c.Now(); got != 5 {
		t.Fatalf("now = %d, want 5", got)
	}
}

func TestBudgetPreventsInfiniteLoop(t *testing.T) {
	const budget = 50
	c := NewClock(budget)
	calls := 0
	var again func()
	again = func() {
		calls++
		c.Schedule(0, again) // re-register at the current tick forever
	}
	c.Schedule(0, again)
	for round := 1; round <= 3; round++ {
		err := c.AdvanceTo(0)
		if !errors.Is(err, ErrBudgetExhausted) {
			t.Fatalf("round %d: err = %v, want ErrBudgetExhausted", round, err)
		}
		if calls != round*budget {
			t.Fatalf("round %d: calls = %d, want %d", round, calls, round*budget)
		}
		if c.Pending() != 1 {
			t.Fatalf("round %d: pending = %d, want 1", round, c.Pending())
		}
	}
	if got := c.Now(); got != 0 {
		t.Fatalf("now = %d, want 0", got)
	}
}

func TestBudgetLeavesLaterTimersPending(t *testing.T) {
	c := NewClock(2)
	c.Schedule(1, func() {})
	c.Schedule(1, func() {})
	c.Schedule(1, func() {})
	if err := c.AdvanceTo(1); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("err = %v, want ErrBudgetExhausted", err)
	}
	if got, want := firedIDs(c), []int{0, 1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fired IDs = %v, want %v", got, want)
	}
	// The remaining timer fires on the next advance.
	if err := c.AdvanceTo(1); err != nil {
		t.Fatal(err)
	}
	if got, want := firedIDs(c), []int{0, 1, 2}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fired IDs = %v, want %v", got, want)
	}
}

func TestBudgetExactFit(t *testing.T) {
	c := NewClock(3)
	for i := 0; i < 3; i++ {
		c.Schedule(2, func() {})
	}
	if err := c.AdvanceTo(2); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if c.Pending() != 0 {
		t.Fatalf("pending = %d, want 0", c.Pending())
	}
}

func TestEventsRecordedAcrossAdvances(t *testing.T) {
	c := NewClock(100)
	c.Schedule(1, func() {})
	c.Schedule(2, func() {})
	c.Schedule(2, func() {})
	if err := c.Advance(1); err != nil {
		t.Fatal(err)
	}
	if err := c.Advance(1); err != nil {
		t.Fatal(err)
	}
	want := []Event{{Tick: 1, ID: 0}, {Tick: 2, ID: 1}, {Tick: 2, ID: 2}}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestAdvanceToDoesNotFireFutureTimers(t *testing.T) {
	c := NewClock(100)
	c.Schedule(10, func() {})
	if err := c.AdvanceTo(9); err != nil {
		t.Fatal(err)
	}
	if got := c.Events(); len(got) != 0 {
		t.Fatalf("events = %v, want none", got)
	}
	if got := c.Now(); got != 9 {
		t.Fatalf("now = %d, want 9", got)
	}
	if c.Pending() != 1 {
		t.Fatalf("pending = %d, want 1", c.Pending())
	}
}

func TestRescheduleFromCallback(t *testing.T) {
	c := NewClock(100)
	var h Timer
	fires := 0
	h = c.Schedule(1, func() {
		fires++
		if fires == 1 {
			var ok bool
			h, ok = c.Reschedule(h, 4)
			if !ok {
				t.Error("Reschedule from callback failed")
			}
		}
	})
	if err := c.AdvanceTo(10); err != nil {
		t.Fatal(err)
	}
	if fires != 2 {
		t.Fatalf("fires = %d, want 2", fires)
	}
	want := []Event{{Tick: 1, ID: h.ID()}, {Tick: 5, ID: h.ID()}}
	if got := c.Events(); !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestPanics(t *testing.T) {
	mustPanic := func(name string, f func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Errorf("%s did not panic", name)
			}
		}()
		f()
	}
	mustPanic("NewClock(0)", func() { NewClock(0) })
	c := NewClock(1)
	mustPanic("Schedule(-1)", func() { c.Schedule(-1, func() {}) })
	mustPanic("Reschedule(-1)", func() { c.Reschedule(c.Schedule(1, func() {}), -1) })
	mustPanic("Advance(-1)", func() { _ = c.Advance(-1) })
	mustPanic("AdvanceTo(past)", func() {
		if err := c.AdvanceTo(5); err != nil {
			t.Error(err)
		}
		_ = c.AdvanceTo(4)
	})
}

func ExampleClock() {
	c := NewClock(100)
	c.Schedule(2, func() { fmt.Println("second") })
	c.Schedule(1, func() { fmt.Println("first") })
	if err := c.AdvanceTo(2); err != nil {
		panic(err)
	}
	// Output:
	// first
	// second
}
