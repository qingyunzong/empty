package timer

import (
	"fmt"
	"reflect"
	"testing"
)

// log appends a formatted "tick:name" entry to *out.
func recorder(c *Clock, out *[]string, name string) func() {
	return func() { *out = append(*out, fmt.Sprintf("%d:%s", c.Now(), name)) }
}

func TestBasicFireAtDeadline(t *testing.T) {
	c := NewClock(0)
	var got []string
	c.AfterFunc(3, recorder(c, &got, "a"))
	c.Advance(2)
	if len(got) != 0 {
		t.Fatalf("fired early: %v", got)
	}
	c.Advance(1)
	if !reflect.DeepEqual(got, []string{"3:a"}) {
		t.Fatalf("got %v", got)
	}
	if c.Now() != 3 {
		t.Fatalf("now = %d, want 3", c.Now())
	}
}

func TestSameTickFiresInCreationOrder(t *testing.T) {
	c := NewClock(0)
	var got []string
	c.AfterFunc(5, recorder(c, &got, "first"))
	c.AfterFunc(5, recorder(c, &got, "second"))
	c.AfterFunc(5, recorder(c, &got, "third"))
	c.Advance(5)
	want := []string{"5:first", "5:second", "5:third"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMixedDeadlinesOrderedByTickThenCreation(t *testing.T) {
	c := NewClock(0)
	var got []string
	c.AfterFunc(7, recorder(c, &got, "late"))
	c.AfterFunc(3, recorder(c, &got, "early1"))
	c.AfterFunc(3, recorder(c, &got, "early2"))
	c.AfterFunc(1, recorder(c, &got, "first"))
	c.Advance(10)
	want := []string{"1:first", "3:early1", "3:early2", "7:late"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestStopPreventsFire(t *testing.T) {
	c := NewClock(0)
	var got []string
	tm := c.AfterFunc(2, recorder(c, &got, "a"))
	if !tm.Stop() {
		t.Fatal("Stop should report a pending event was cancelled")
	}
	if tm.Stop() {
		t.Fatal("second Stop should report false")
	}
	c.Advance(10)
	if len(got) != 0 {
		t.Fatalf("stopped timer fired: %v", got)
	}
}

func TestResetMasksEnqueuedOldGeneration(t *testing.T) {
	c := NewClock(0)
	var got []string
	tm := c.AfterFunc(2, recorder(c, &got, "old"))
	// Reset at tick 1: the event enqueued for tick 2 belongs to the old
	// generation and must be masked even though it is already enqueued.
	c.Advance(1)
	tm2 := tm
	tm2.Reset(5) // new generation fires at tick 6
	c.Advance(10)
	want := []string{"6:old"} // only the new generation fires, at its new tick
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestResetToSameTickStillMasksOldEvent(t *testing.T) {
	c := NewClock(0)
	var got []string
	tm := c.AfterFunc(2, recorder(c, &got, "gen1"))
	c.Advance(1)
	tm.Reset(1) // new generation also due at tick 2
	c.Advance(1)
	// Exactly one firing: the old generation's tick-2 event is masked.
	want := []string{"2:gen1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	c.Advance(5) // nothing left
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("extra firing: %v", got)
	}
}

func TestCallbackResetsItself(t *testing.T) {
	c := NewClock(0)
	var got []string
	var tm *Timer
	fires := 0
	tm = c.AfterFunc(2, func() {
		fires++
		got = append(got, fmt.Sprintf("%d:fire%d", c.Now(), fires))
		if fires < 3 {
			tm.Reset(2) // reschedule relative to current tick
		}
	})
	c.Advance(20)
	want := []string{"2:fire1", "4:fire2", "6:fire3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCallbackResetWithZeroDelayFiresWithinSameAdvance(t *testing.T) {
	c := NewClock(0)
	var got []string
	var tm *Timer
	fires := 0
	tm = c.AfterFunc(3, func() {
		fires++
		got = append(got, fmt.Sprintf("%d:fire%d", c.Now(), fires))
		if fires < 3 {
			tm.Reset(0)
		}
	})
	c.Advance(3)
	want := []string{"3:fire1", "3:fire2", "3:fire3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCallbackStoppingOtherTimer(t *testing.T) {
	c := NewClock(0)
	var got []string
	victim := c.AfterFunc(4, recorder(c, &got, "victim"))
	c.AfterFunc(2, func() {
		got = append(got, "2:killer")
		if !victim.Stop() {
			t.Error("victim should have been pending")
		}
	})
	c.Advance(10)
	want := []string{"2:killer"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCallbackResettingOtherTimer(t *testing.T) {
	c := NewClock(0)
	var got []string
	other := c.AfterFunc(4, recorder(c, &got, "other"))
	c.AfterFunc(2, func() {
		got = append(got, "2:resetter")
		other.Reset(3) // now due at tick 5; tick-4 event masked
	})
	c.Advance(10)
	want := []string{"2:resetter", "5:other"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestStopAfterFireReturnsFalse(t *testing.T) {
	c := NewClock(0)
	var got []string
	tm := c.AfterFunc(1, recorder(c, &got, "a"))
	c.Advance(1)
	if tm.Stop() {
		t.Fatal("Stop after fire should report false")
	}
}

func TestResetAfterStopRevivesTimer(t *testing.T) {
	c := NewClock(0)
	var got []string
	tm := c.AfterFunc(2, recorder(c, &got, "a"))
	tm.Stop()
	tm.Reset(3) // due at tick 3
	c.Advance(10)
	want := []string{"3:a"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestAdvanceToAbsoluteAndNegativePanics(t *testing.T) {
	c := NewClock(10)
	var got []string
	c.AfterFunc(5, recorder(c, &got, "a")) // due at 15
	c.AdvanceTo(15)
	if !reflect.DeepEqual(got, []string{"15:a"}) {
		t.Fatalf("got %v", got)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on backwards AdvanceTo")
		}
	}()
	c.AdvanceTo(14)
}

func TestClockTimeTracksEventDeadlinesDuringAdvance(t *testing.T) {
	c := NewClock(0)
	var got []string
	c.AfterFunc(2, recorder(c, &got, "a"))
	c.AfterFunc(9, recorder(c, &got, "b"))
	c.Advance(10) // callbacks observe their own deadline, final now = 10
	want := []string{"2:a", "9:b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if c.Now() != 10 {
		t.Fatalf("now = %d, want 10", c.Now())
	}
}
