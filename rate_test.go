package counterrate

import (
	"math"
	"testing"
	"time"
)

func almost(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// 100 -> 5 with a restart marker: the new epoch is a fresh segment, the
// drop is not a negative delta, and the window records one reset.
func TestMarkedRestartStartsNewSegment(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	s.Add(at(0, 100), at(10, 140), at(20, 5, true), at(30, 25))
	r, err := s.WindowRate(t0, t0.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if r.Uncertain {
		t.Fatal("marked restart must not be uncertain")
	}
	if r.Resets != 1 {
		t.Fatalf("resets=%d want 1", r.Resets)
	}
	// seg1: 100 -> 140 (+40, clamped at t=20); seg2: 5 -> 25 (+20).
	if !almost(r.Increase, 60) || !almost(r.Rate, 2.0) {
		t.Fatalf("increase=%v rate=%v, want 60 and 2.0", r.Increase, r.Rate)
	}
}

// 100 -> 5 without a marker: the negative delta is skipped (never a fake
// negative rate) and the window is flagged uncertain.
func TestUnmarkedRollbackIsUncertain(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	s.Add(at(0, 100), at(10, 140), at(20, 5), at(30, 25))
	r, err := s.WindowRate(t0, t0.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !r.Uncertain {
		t.Fatal("unmarked rollback must flag Uncertain")
	}
	if r.Resets != 0 {
		t.Fatalf("resets=%d want 0", r.Resets)
	}
	if r.Rate < 0 {
		t.Fatalf("negative rate fabricated: %v", r.Rate)
	}
	// +40 and +20 counted, the -135 drop skipped.
	if !almost(r.Increase, 60) {
		t.Fatalf("increase=%v want 60", r.Increase)
	}
}

// Window boundaries are linearly interpolated between neighbours.
func TestBoundaryInterpolation(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	s.Add(at(0, 0), at(10, 100))
	r, err := s.WindowRate(t0.Add(5*time.Second), t0.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	// value(5s)=50, value(10s)=100 -> +50 over 5s.
	if !almost(r.Increase, 50) || !almost(r.Rate, 10) {
		t.Fatalf("increase=%v rate=%v, want 50 and 10", r.Increase, r.Rate)
	}
}

// Outside the sample range values clamp to the nearest sample; the counter
// is never extrapolated.
func TestBoundaryClampNoExtrapolation(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	s.Add(at(10, 100), at(20, 200))
	r, err := s.WindowRate(t0, t0.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	// clamped: value(0)=100, value(30)=200 -> +100 over 30s.
	if !almost(r.Increase, 100) || !almost(r.Rate, 100.0/30.0) {
		t.Fatalf("increase=%v rate=%v, want 100 and 3.333", r.Increase, r.Rate)
	}
}

func TestEmptyWindowRejected(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	s.Add(at(0, 1))
	if _, err := s.WindowRate(t0, t0); err != ErrEmptyWindow {
		t.Fatalf("want ErrEmptyWindow, got %v", err)
	}
}

func TestResetOutsideWindowNotCounted(t *testing.T) {
	s := NewSeries(ConflictLastWins)
	s.Add(at(0, 0), at(10, 10), at(20, 1, true), at(30, 11))
	r, err := s.WindowRate(t0, t0.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if r.Resets != 0 || r.Uncertain {
		t.Fatalf("window before restart: %+v", r)
	}
	if !almost(r.Increase, 10) {
		t.Fatalf("increase=%v want 10", r.Increase)
	}
}
