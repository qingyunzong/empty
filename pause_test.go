package dataeng

import (
	"errors"
	"math"
	"sync"
	"testing"
	"time"
)

// fakeClock is a virtual clock with independently controllable wall and
// monotonic readings.
type fakeClock struct {
	mu   sync.Mutex
	wall time.Time
	mono time.Duration
}

func newFakeClock() *fakeClock {
	return &fakeClock{wall: time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.wall
}

func (c *fakeClock) Monotonic() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mono
}

// Advance moves both clocks forward, as real time would.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
	c.mono += d
}

// JumpWall moves only the wall clock, simulating an NTP step.
func (c *fakeClock) JumpWall(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wall = c.wall.Add(d)
}

func respond(c *fakeClock, source string, version uint64, ra RetryAfter) Response {
	return Response{
		Source:     source,
		Version:    version,
		Received:   c.Now(),
		Mono:       c.Monotonic(),
		RetryAfter: ra,
	}
}

func TestDeltaSecondsPauseAndExpiry(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(30))); err != nil {
		t.Fatal(err)
	}
	if !tr.Paused("a") {
		t.Fatal("expected pause right after failure")
	}
	clk.Advance(29 * time.Second)
	if !tr.Paused("a") {
		t.Fatal("expected pause to persist at 29s")
	}
	clk.Advance(2 * time.Second)
	if tr.Paused("a") {
		t.Fatal("expected pause to expire at 31s")
	}
}

func TestAbsoluteWaitUsesServerDate(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	// Server clock is 5s behind the receiver; the absolute deadline is 20s
	// ahead of the receive wall time, so the server-relative wait is 25s.
	received := clk.Now()
	date := received.Add(-5 * time.Second)
	resp := Response{
		Source:     "a",
		Version:    1,
		Received:   received,
		Mono:       clk.Monotonic(),
		Date:       &date,
		RetryAfter: AtAbsolute(received.Add(20 * time.Second)),
	}
	if err := tr.RecordFailure(resp); err != nil {
		t.Fatal(err)
	}
	want := clk.Monotonic() + 25*time.Second
	got, ok := tr.Deadline("a")
	if !ok || got != want {
		t.Fatalf("deadline = %v, %v; want %v", got, ok, want)
	}
}

func TestAbsoluteWaitFallsBackToReceiveUTC(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	received := clk.Now()
	resp := Response{
		Source:     "a",
		Version:    1,
		Received:   received,
		Mono:       clk.Monotonic(),
		RetryAfter: AtAbsolute(received.Add(40 * time.Second)),
	}
	if err := tr.RecordFailure(resp); err != nil {
		t.Fatal(err)
	}
	want := clk.Monotonic() + 40*time.Second
	got, ok := tr.Deadline("a")
	if !ok || got != want {
		t.Fatalf("deadline = %v, %v; want %v", got, ok, want)
	}
}

func TestAbsoluteWaitInPastClampsToZero(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	resp := respond(clk, "a", 1, AtAbsolute(clk.Now().Add(-time.Minute)))
	if err := tr.RecordFailure(resp); err != nil {
		t.Fatal(err)
	}
	if tr.Paused("a") {
		t.Fatal("past absolute date must not pause")
	}
}

func TestWallClockJumpDoesNotAffectMonotonicDeadline(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(60))); err != nil {
		t.Fatal(err)
	}
	clk.JumpWall(-time.Hour)
	if !tr.Paused("a") {
		t.Fatal("backward wall jump must not clear the pause")
	}
	clk.JumpWall(2 * time.Hour)
	if !tr.Paused("a") {
		t.Fatal("forward wall jump must not expire the pause")
	}
	clk.Advance(61 * time.Second)
	if tr.Paused("a") {
		t.Fatal("pause must expire on monotonic advance")
	}
}

func TestOutOfOrderKeepsMaxDeadline(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	// Same version, same content, received twice at different instants.
	first := respond(clk, "a", 1, AfterSeconds(60))
	if err := tr.RecordFailure(first); err != nil {
		t.Fatal(err)
	}
	clk.Advance(10 * time.Second)
	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(60))); err != nil {
		t.Fatal(err)
	}
	want := clk.Monotonic() + 60*time.Second
	if got, ok := tr.Deadline("a"); !ok || got != want {
		t.Fatalf("deadline = %v, %v; want %v", got, ok, want)
	}
	// A delayed copy of the earlier response must not shrink the deadline.
	if err := tr.RecordFailure(first); err != nil {
		t.Fatal(err)
	}
	if got, ok := tr.Deadline("a"); !ok || got != want {
		t.Fatalf("deadline = %v, %v; want %v", got, ok, want)
	}
	// A newer version with a longer Retry-After extends the source pause.
	if err := tr.RecordFailure(respond(clk, "a", 2, AfterSeconds(120))); err != nil {
		t.Fatal(err)
	}
	want = clk.Monotonic() + 120*time.Second
	if got, ok := tr.Deadline("a"); !ok || got != want {
		t.Fatalf("deadline = %v, %v; want %v", got, ok, want)
	}
}

func TestSuccessClearsAndBarrierRejectsStaleFailures(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	for v := uint64(1); v <= 3; v++ {
		if err := tr.RecordFailure(respond(clk, "a", v, AfterSeconds(300))); err != nil {
			t.Fatal(err)
		}
	}
	if err := tr.RecordSuccess("a", 2); err != nil {
		t.Fatal(err)
	}
	// Versions 1 and 2 are cleared; version 3 survives.
	want := clk.Monotonic() + 300*time.Second
	if got, ok := tr.Deadline("a"); !ok || got != want {
		t.Fatalf("deadline = %v, %v; want %v", got, ok, want)
	}
	// A late failure for cleared version 1 must not resurrect a pause.
	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(900))); err != nil {
		t.Fatal(err)
	}
	if got, ok := tr.Deadline("a"); !ok || got != want {
		t.Fatalf("stale failure resurrected pause: deadline = %v, %v; want %v", got, ok, want)
	}
	// A failure newer than the barrier is accepted.
	if err := tr.RecordFailure(respond(clk, "a", 4, AfterSeconds(10))); err != nil {
		t.Fatal(err)
	}
	if got, ok := tr.Deadline("a"); !ok || got != want {
		t.Fatalf("newer failure must keep max deadline: got %v, %v; want %v", got, ok, want)
	}
	// Success at version 4 clears everything.
	if err := tr.RecordSuccess("a", 4); err != nil {
		t.Fatal(err)
	}
	if tr.Paused("a") {
		t.Fatal("success at version 4 must clear all pauses")
	}
}

func TestInvalidVersionRejected(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	if err := tr.RecordFailure(respond(clk, "a", 0, AfterSeconds(1))); !errors.Is(err, ErrInvalidVersion) {
		t.Fatalf("RecordFailure err = %v; want ErrInvalidVersion", err)
	}
	if err := tr.RecordSuccess("a", 0); !errors.Is(err, ErrInvalidVersion) {
		t.Fatalf("RecordSuccess err = %v; want ErrInvalidVersion", err)
	}
}

func TestSameVersionDifferentContentRejected(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(10))); err != nil {
		t.Fatal(err)
	}
	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(10))); err != nil {
		t.Fatalf("identical retry must be accepted: %v", err)
	}
	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(20))); !errors.Is(err, ErrInconsistentVersion) {
		t.Fatalf("err = %v; want ErrInconsistentVersion", err)
	}
}

func TestHugeRetryAfterSaturatesWithoutOverflow(t *testing.T) {
	clk := newFakeClock()
	tr := NewTrackerWithClock(clk)

	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(math.MaxUint64))); err != nil {
		t.Fatal(err)
	}
	got, ok := tr.Deadline("a")
	if !ok || got != time.Duration(math.MaxInt64) {
		t.Fatalf("deadline = %v, %v; want saturated MaxInt64", got, ok)
	}
	clk.Advance(1000 * time.Hour)
	if !tr.Paused("a") {
		t.Fatal("saturated deadline must remain paused")
	}
}

func TestMonotonicNearLimitDoesNotOverflow(t *testing.T) {
	clk := newFakeClock()
	clk.mono = time.Duration(math.MaxInt64) - time.Second
	tr := NewTrackerWithClock(clk)

	if err := tr.RecordFailure(respond(clk, "a", 1, AfterSeconds(3600))); err != nil {
		t.Fatal(err)
	}
	got, ok := tr.Deadline("a")
	if !ok || got != time.Duration(math.MaxInt64) {
		t.Fatalf("deadline = %v, %v; want saturated MaxInt64", got, ok)
	}
}
