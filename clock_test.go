package readwait

import (
	"testing"
	"time"
)

func TestManualClockFiresOnAdvance(t *testing.T) {
	clk := NewManualClock(time.Unix(0, 0))
	fired := 0
	clk.AfterFunc(10*time.Second, func() { fired++ })

	clk.Advance(9 * time.Second)
	if fired != 0 {
		t.Fatalf("timer fired early: %d", fired)
	}
	clk.Advance(1 * time.Second)
	if fired != 1 {
		t.Fatalf("timer did not fire at deadline: %d", fired)
	}
}

func TestManualClockStop(t *testing.T) {
	clk := NewManualClock(time.Unix(0, 0))
	fired := 0
	timer := clk.AfterFunc(time.Second, func() { fired++ })
	if !timer.Stop() {
		t.Fatal("Stop returned false for pending timer")
	}
	clk.Advance(time.Minute)
	if fired != 0 {
		t.Fatal("stopped timer fired")
	}
	if timer.Stop() {
		t.Fatal("Stop returned true for already-stopped timer")
	}
}

func TestManualClockDeadlineOrder(t *testing.T) {
	clk := NewManualClock(time.Unix(0, 0))
	var order []int
	clk.AfterFunc(2*time.Second, func() { order = append(order, 2) })
	clk.AfterFunc(1*time.Second, func() { order = append(order, 1) })
	clk.Advance(3 * time.Second)
	if len(order) != 2 || order[0] != 1 || order[1] != 2 {
		t.Fatalf("timers fired out of deadline order: %v", order)
	}
}
