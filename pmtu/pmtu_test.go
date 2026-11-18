package pmtu

import (
	"testing"
	"time"
)

func testConfig() Config {
	return Config{
		MinMTU:        500,
		MaxMTU:        1500,
		ProbeStep:     200,
		AgeTimeout:    10 * time.Second,
		MaxProbeFails: 2,
	}
}

var t0 = time.Unix(1_700_000_000, 0)

func TestTrustedErrorLowersMTU(t *testing.T) {
	c := New(testConfig())
	if got := c.MTU("a", t0); got != 1500 {
		t.Fatalf("initial MTU = %d, want 1500", got)
	}
	c.Update("a", 1200, true, t0)
	if got := c.MTU("a", t0); got != 1200 {
		t.Fatalf("after trusted error MTU = %d, want 1200", got)
	}
}

func TestUntrustedErrorIgnored(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 800, false, t0)
	if got := c.MTU("a", t0); got != 1500 {
		t.Fatalf("untrusted error changed MTU to %d", got)
	}
	c.Update("a", 1200, true, t0)
	c.Update("a", 800, false, t0)
	if got := c.MTU("a", t0); got != 1200 {
		t.Fatalf("untrusted error lowered MTU to %d", got)
	}
}

func TestErrorClampedToMinMTU(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 100, true, t0)
	if got := c.MTU("a", t0); got != 500 {
		t.Fatalf("MTU = %d, want clamp to 500", got)
	}
}

func TestStaleErrorIgnored(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 1200, true, t0)
	c.Update("a", 1400, true, t0) // above confirmed: stale
	if got := c.MTU("a", t0); got != 1200 {
		t.Fatalf("stale error raised MTU to %d", got)
	}
}

func TestAgingStartsProbingWithoutRaisingMTU(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 1000, true, t0)
	before := t0.Add(9 * time.Second)
	if _, ok := c.NextProbe("a", before); ok {
		t.Fatal("probe offered before aging elapsed")
	}
	after := t0.Add(11 * time.Second)
	if got := c.MTU("a", after); got != 1000 {
		t.Fatalf("aging changed data MTU to %d", got)
	}
	size, ok := c.NextProbe("a", after)
	if !ok || size != 1200 {
		t.Fatalf("probe = %d,%v want 1200,true", size, ok)
	}
	// While the probe is in flight the data MTU stays at the floor.
	if got := c.MTU("a", after); got != 1000 {
		t.Fatalf("probing raised data MTU to %d", got)
	}
	if _, ok := c.NextProbe("a", after); ok {
		t.Fatal("second probe offered while one is in flight")
	}
}

func TestProbeAckRaisesStepwiseToCeiling(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 1000, true, t0)
	now := t0.Add(11 * time.Second)
	for _, want := range []int{1200, 1400, 1500} {
		size, ok := c.NextProbe("a", now)
		if !ok || size != want {
			t.Fatalf("probe = %d,%v want %d,true", size, ok, want)
		}
		c.ProbeAck("a", size, now)
		if got := c.MTU("a", now); got != want {
			t.Fatalf("MTU after ack = %d, want %d", got, want)
		}
	}
	if _, ok := c.NextProbe("a", now); ok {
		t.Fatal("probe offered after reaching ceiling")
	}
}

func TestProbeRejectedByErrorKeepsFloor(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 1000, true, t0)
	now := t0.Add(11 * time.Second)
	if _, ok := c.NextProbe("a", now); !ok {
		t.Fatal("no probe offered")
	}
	// Router rejects the probe size; the floor must not move.
	c.Update("a", 1100, true, now)
	if got := c.MTU("a", now); got != 1000 {
		t.Fatalf("MTU = %d, want 1000", got)
	}
	// Second failure pauses probing for a full aging interval.
	if _, ok := c.NextProbe("a", now); !ok {
		t.Fatal("retry probe not offered")
	}
	c.Update("a", 1100, true, now)
	if _, ok := c.NextProbe("a", now.Add(time.Second)); ok {
		t.Fatal("probe offered during black-hole pause")
	}
	if _, ok := c.NextProbe("a", now.Add(11*time.Second)); !ok {
		t.Fatal("probe not resumed after pause interval")
	}
}

func TestProbeLossBlackHole(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 1000, true, t0)
	now := t0.Add(11 * time.Second)
	for i := 0; i < 2; i++ {
		if _, ok := c.NextProbe("a", now); !ok {
			t.Fatalf("probe %d not offered", i)
		}
		c.ProbeLost("a", now)
	}
	if _, ok := c.NextProbe("a", now.Add(time.Second)); ok {
		t.Fatal("probe offered during black-hole pause")
	}
	if got := c.MTU("a", now); got != 1000 {
		t.Fatalf("MTU = %d, want 1000", got)
	}
}

func TestErrorDuringProbeLowersFloor(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 1000, true, t0)
	now := t0.Add(11 * time.Second)
	c.NextProbe("a", now)
	c.Update("a", 700, true, now) // path got worse mid-probe
	if got := c.MTU("a", now); got != 700 {
		t.Fatalf("MTU = %d, want 700", got)
	}
	if _, ok := c.NextProbe("a", now); ok {
		t.Fatal("probe still outstanding after decrease")
	}
}

func TestPerPathIndependence(t *testing.T) {
	c := New(testConfig())
	c.Update("a", 900, true, t0)
	c.Update("b", 1300, true, t0)
	if got := c.MTU("a", t0); got != 900 {
		t.Fatalf("a MTU = %d, want 900", got)
	}
	if got := c.MTU("b", t0); got != 1300 {
		t.Fatalf("b MTU = %d, want 1300", got)
	}
	if got := c.MTU("c", t0); got != 1500 {
		t.Fatalf("c MTU = %d, want 1500", got)
	}
}

func TestNoOscillationUnderInterleaving(t *testing.T) {
	c := New(testConfig())
	var history []int
	record := func(now time.Time) {
		history = append(history, c.MTU("a", now))
	}
	c.Update("a", 1000, true, t0)
	record(t0)
	now := t0.Add(11 * time.Second)
	record(now) // aging: no change
	size, _ := c.NextProbe("a", now)
	c.ProbeAck("a", size, now)
	record(now) // up to 1200
	c.Update("a", 1100, true, now)
	record(now) // down to 1100
	c.Update("a", 1100, true, now)
	record(now) // duplicate error: no change
	now = now.Add(11 * time.Second)
	record(now) // aging again: no change
	want := []int{1000, 1000, 1200, 1100, 1100, 1100}
	for i := range want {
		if history[i] != want[i] {
			t.Fatalf("history[%d] = %d, want %d (full %v)", i, history[i], want[i], history)
		}
	}
}
