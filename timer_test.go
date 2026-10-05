package timer

import (
	"reflect"
	"testing"
)

// log is a shared firing log for a test.
type log struct{ entries []string }

func (l *log) fn(name string) func() {
	return func() { l.entries = append(l.entries, name) }
}

func (l *log) check(t *testing.T, want []string) {
	t.Helper()
	if !reflect.DeepEqual(l.entries, want) {
		t.Fatalf("firing log = %v, want %v", l.entries, want)
	}
}

func TestBasicFireAndClockPosition(t *testing.T) {
	c := NewClock()
	var l log
	c.AfterFunc(3, l.fn("a"))
	c.AfterFunc(1, l.fn("b"))

	c.Advance(1)
	l.check(t, []string{"b"})
	if got := c.Now(); got != 1 {
		t.Fatalf("Now = %d, want 1", got)
	}

	c.Advance(5)
	l.check(t, []string{"b", "a"})
	// Clock ends at the advance target, not at the last event.
	if got := c.Now(); got != 6 {
		t.Fatalf("Now = %d, want 6", got)
	}
}

func TestSameTickCreationOrder(t *testing.T) {
	c := NewClock()
	var l log
	c.AfterFunc(2, l.fn("first"))
	c.AfterFunc(1, l.fn("earlier-deadline"))
	c.AfterFunc(2, l.fn("second"))
	c.AfterFunc(2, l.fn("third"))

	c.Advance(2)
	l.check(t, []string{"earlier-deadline", "first", "second", "third"})
}

func TestStopBeforeFire(t *testing.T) {
	c := NewClock()
	var l log
	tm := c.AfterFunc(2, l.fn("a"))

	if !tm.Stop() {
		t.Fatal("first Stop = false, want true")
	}
	if tm.Stop() {
		t.Fatal("second Stop = true, want false")
	}
	c.Advance(10)
	l.check(t, nil)
}

func TestStopAfterFireReturnsFalse(t *testing.T) {
	c := NewClock()
	var l log
	tm := c.AfterFunc(1, l.fn("a"))
	c.Advance(1)
	if tm.Stop() {
		t.Fatal("Stop after fire = true, want false")
	}
	l.check(t, []string{"a"})
}

func TestResetMasksEnqueuedEvent(t *testing.T) {
	c := NewClock()
	var l log
	tm := c.AfterFunc(5, l.fn("stale"))

	c.Advance(1) // t=1; the original event is enqueued for t=5
	tm.Reset(2)  // new generation, due at t=3

	c.Advance(2) // t=3
	l.check(t, []string{"stale"})
	if got := c.Now(); got != 3 {
		t.Fatalf("Now = %d, want 3", got)
	}

	// The masked event from the old generation (t=5) must never fire.
	c.Advance(10)
	l.check(t, []string{"stale"})
}

func TestResetToSameDeadlineFiresOnce(t *testing.T) {
	c := NewClock()
	var l log
	tm := c.AfterFunc(2, l.fn("a"))
	tm.Reset(2) // same deadline as the original event
	c.Advance(2)
	l.check(t, []string{"a"})
}

func TestResetAfterFire(t *testing.T) {
	c := NewClock()
	var l log
	tm := c.AfterFunc(1, l.fn("a"))
	c.Advance(1)
	l.check(t, []string{"a"})

	tm.Reset(2)
	c.Advance(2)
	l.check(t, []string{"a", "a"})
}

func TestCallbackResetsItself(t *testing.T) {
	c := NewClock()
	var fires []int64
	var tm *Timer
	count := 0
	tm = c.AfterFunc(2, func() {
		fires = append(fires, c.Now())
		count++
		if count < 3 {
			tm.Reset(2) // re-arm from inside the callback
		}
	})
	c.Advance(10)
	if want := []int64{2, 4, 6}; !reflect.DeepEqual(fires, want) {
		t.Fatalf("fires = %v, want %v", fires, want)
	}
	if tm.Stop() {
		t.Fatal("timer should have been idle after 3 fires")
	}
}

func TestCallbackResetsItselfWithZeroDelay(t *testing.T) {
	c := NewClock()
	var fires []int64
	var tm *Timer
	count := 0
	tm = c.AfterFunc(0, func() {
		fires = append(fires, c.Now())
		count++
		if count < 3 {
			tm.Reset(0)
		}
	})
	// All three fires happen within a single Advance(0).
	c.Advance(0)
	if want := []int64{0, 0, 0}; !reflect.DeepEqual(fires, want) {
		t.Fatalf("fires = %v, want %v", fires, want)
	}
}

func TestCallbackStopsOtherTimer(t *testing.T) {
	c := NewClock()
	var l log
	victim := c.AfterFunc(2, l.fn("victim"))
	c.AfterFunc(1, func() {
		l.entries = append(l.entries, "killer")
		if !victim.Stop() {
			t.Error("Stop of pending victim = false, want true")
		}
	})
	c.Advance(5)
	l.check(t, []string{"killer"})
}

func TestCallbackResetsOtherTimer(t *testing.T) {
	c := NewClock()
	var l log
	other := c.AfterFunc(2, l.fn("other"))
	c.AfterFunc(1, func() {
		l.entries = append(l.entries, "resetter")
		other.Reset(3) // now due at t=4, masking the t=2 event
	})
	c.Advance(3)
	l.check(t, []string{"resetter"})
	c.Advance(1) // t=4
	l.check(t, []string{"resetter", "other"})
}

func TestSameTickOrderWithReset(t *testing.T) {
	c := NewClock()
	var l log
	c.AfterFunc(2, l.fn("a"))
	b := c.AfterFunc(2, l.fn("b"))
	c.AfterFunc(2, l.fn("c"))
	// b re-arms at t=0 with the same deadline, but its new event is
	// created after a's and c's, so it fires last among the three.
	b.Reset(2)
	c.Advance(2)
	l.check(t, []string{"a", "c", "b"})
}

func TestZeroDelayFiresOnAdvanceZero(t *testing.T) {
	c := NewClock()
	var l log
	c.AfterFunc(0, l.fn("now"))
	c.Advance(0)
	l.check(t, []string{"now"})
}

func TestNegativeDelayPanics(t *testing.T) {
	c := NewClock()
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for negative delay")
		}
	}()
	c.AfterFunc(-1, func() {})
}
