package readroute

import (
	"testing"
	"time"
)

func TestVirtualClockAfterAndAdvance(t *testing.T) {
	c := NewVirtualClock(time.Unix(1000, 0))
	ch := c.After(10 * time.Second)

	select {
	case <-ch:
		t.Fatal("timer fired before the clock advanced")
	default:
	}

	c.Advance(5 * time.Second)
	select {
	case <-ch:
		t.Fatal("timer fired before its deadline")
	default:
	}

	c.Advance(5 * time.Second)
	select {
	case at := <-ch:
		if want := time.Unix(1000, 0).Add(10 * time.Second); !at.Equal(want) {
			t.Fatalf("timer fired at %v, want %v", at, want)
		}
	default:
		t.Fatal("timer did not fire at its deadline")
	}
}
