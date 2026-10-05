package aggregator

import (
	"testing"
	"time"
)

func TestVirtualClockAdvanceFiresExpiredTimers(t *testing.T) {
	clock := NewVirtualClock(time.Unix(0, 0))
	var fired []string
	clock.AfterFunc(10*time.Millisecond, func() { fired = append(fired, "a") })
	clock.AfterFunc(20*time.Millisecond, func() { fired = append(fired, "b") })

	clock.Advance(10 * time.Millisecond)
	if len(fired) != 1 || fired[0] != "a" {
		t.Fatalf("after 10ms: fired = %v, want [a]", fired)
	}
	clock.Advance(10 * time.Millisecond)
	if len(fired) != 2 || fired[1] != "b" {
		t.Fatalf("after 20ms: fired = %v, want [a b]", fired)
	}
}

func TestVirtualClockTimerStop(t *testing.T) {
	clock := NewVirtualClock(time.Unix(0, 0))
	fired := false
	timer := clock.AfterFunc(time.Millisecond, func() { fired = true })
	if !timer.Stop() {
		t.Fatal("Stop on pending timer = false, want true")
	}
	if timer.Stop() {
		t.Fatal("second Stop = true, want false")
	}
	clock.Advance(time.Hour)
	if fired {
		t.Fatal("stopped timer fired")
	}
}

func TestVirtualClockFiresInDeadlineOrder(t *testing.T) {
	clock := NewVirtualClock(time.Unix(0, 0))
	var order []int
	clock.AfterFunc(30*time.Millisecond, func() { order = append(order, 3) })
	clock.AfterFunc(10*time.Millisecond, func() { order = append(order, 1) })
	clock.AfterFunc(20*time.Millisecond, func() { order = append(order, 2) })
	clock.Advance(time.Hour)
	want := []int{1, 2, 3}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}
