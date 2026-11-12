package dataeng

import (
	"testing"
	"time"
)

func TestFakeClockTimerFiresOnAdvance(t *testing.T) {
	clk := NewFakeClock(time.Unix(100, 0))
	t1 := clk.NewTimer(5 * time.Second)
	t2 := clk.NewTimer(2 * time.Second)

	clk.Advance(3 * time.Second)
	if clk.Now() != time.Unix(103, 0) {
		t.Fatalf("now = %v", clk.Now())
	}
	select {
	case <-t2.C():
	default:
		t.Fatal("2s timer should have fired")
	}
	select {
	case <-t1.C():
		t.Fatal("5s timer must not fire yet")
	default:
	}

	clk.Advance(2 * time.Second)
	select {
	case <-t1.C():
	default:
		t.Fatal("5s timer should have fired")
	}
}

func TestFakeClockTimerStopAndReset(t *testing.T) {
	clk := NewFakeClock(time.Unix(0, 0))
	tm := clk.NewTimer(time.Minute)
	if !tm.Stop() {
		t.Fatal("Stop on active timer should return true")
	}
	clk.Advance(2 * time.Minute)
	// A stopped timer never delivers a tick; its channel is closed instead.
	if _, ok := <-tm.C(); ok {
		t.Fatal("stopped timer must not deliver a tick")
	}

	tm.Reset(time.Second)
	clk.Advance(time.Second)
	select {
	case <-tm.C():
	default:
		t.Fatal("reset timer should fire")
	}

	// Reusing a fired timer via Reset works.
	tm.Reset(time.Second)
	clk.Advance(time.Second)
	select {
	case <-tm.C():
	default:
		t.Fatal("re-reset timer should fire")
	}
}

func TestFakeClockFiresInDeadlineOrder(t *testing.T) {
	clk := NewFakeClock(time.Unix(0, 0))
	var order []int
	timers := []struct {
		d time.Duration
		i int
	}{
		{3 * time.Second, 3},
		{time.Second, 1},
		{2 * time.Second, 2},
	}
	chs := make([]<-chan time.Time, len(timers))
	for _, spec := range timers {
		spec := spec
		chs[spec.i-1] = clk.NewTimer(spec.d).C()
	}
	clk.Advance(10 * time.Second)
	// Timer channels are buffered and filled in deadline order by Advance.
	for i, ch := range chs {
		select {
		case <-ch:
			order = append(order, i+1)
		default:
			t.Fatalf("timer %d did not fire", i+1)
		}
	}
	want := []int{1, 2, 3}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("fire order = %v, want %v", order, want)
		}
	}
}

func TestRealClockTimer(t *testing.T) {
	clk := NewRealClock()
	tm := clk.NewTimer(10 * time.Millisecond)
	select {
	case <-tm.C():
	case <-time.After(testTimeout):
		t.Fatal("real timer did not fire")
	}
	if tm.Stop() {
		t.Fatal("Stop after fire should return false")
	}
}
