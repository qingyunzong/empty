package railplan

import (
	"errors"
	"testing"
)

func res(track string, start, end int) Reservation {
	return Reservation{Track: track, Span: Interval{Start: start, End: end}}
}

func TestHalfOpenIntervals(t *testing.T) {
	p := New()
	if err := p.Add("A", []Reservation{res("T1", 0, 10)}); err != nil {
		t.Fatal(err)
	}
	// Touching at the endpoint is not a conflict for half-open intervals.
	if err := p.Add("B", []Reservation{res("T1", 10, 20)}); err != nil {
		t.Fatalf("adjacent half-open intervals must not conflict: %v", err)
	}
	// Overlap by one moment on the same track conflicts.
	if err := p.Add("C", []Reservation{res("T1", 9, 11)}); err == nil {
		t.Fatal("expected conflict for overlapping same-track interval")
	} else {
		var ce *ConflictError
		if !errors.As(err, &ce) {
			t.Fatalf("expected ConflictError, got %v", err)
		}
	}
	// Same interval on a different track is fine.
	if err := p.Add("D", []Reservation{res("T2", 0, 10)}); err != nil {
		t.Fatalf("different track must not conflict: %v", err)
	}
}

func TestRescheduleWholeExcludesOwnOld(t *testing.T) {
	p := New()
	if err := p.Add("A", []Reservation{res("T1", 0, 10), res("T2", 5, 8)}); err != nil {
		t.Fatal(err)
	}
	// New layout overlaps the train's own old reservations; that must be fine.
	next := []Reservation{res("T1", 5, 15), res("T2", 5, 8)}
	if err := p.RescheduleWhole("A", next); err != nil {
		t.Fatalf("own old reservations must be excluded from the check: %v", err)
	}
	got := p.Reservations("A")
	if len(got) != 2 || got[0].Span.Start != 5 {
		t.Fatalf("layout not replaced: %v", got)
	}
}

func TestRescheduleWholeFailureKeepsOld(t *testing.T) {
	p := New()
	must := func(train string, layout []Reservation) {
		t.Helper()
		if err := p.Add(train, layout); err != nil {
			t.Fatal(err)
		}
	}
	must("A", []Reservation{res("T1", 0, 10)})
	must("B", []Reservation{res("T1", 20, 30)})

	old := p.Reservations("A")
	// New layout collides with B.
	if err := p.RescheduleWhole("A", []Reservation{res("T1", 25, 35)}); err == nil {
		t.Fatal("expected conflict with B")
	}
	if got := p.Reservations("A"); !sameLayout(got, old) {
		t.Fatalf("failed reschedule must keep old layout: got %v want %v", got, old)
	}
	// Invalid interval (outside domain) also keeps the old layout.
	if err := p.RescheduleWhole("A", []Reservation{res("T1", 990, MaxTime+1)}); err == nil {
		t.Fatal("expected domain validation error")
	}
	if got := p.Reservations("A"); !sameLayout(got, old) {
		t.Fatalf("invalid reschedule must keep old layout: got %v want %v", got, old)
	}
}

func sameLayout(a, b []Reservation) bool {
	if len(a) != len(b) {
		return false
	}
	key := func(rs []Reservation) map[Reservation]int {
		m := map[Reservation]int{}
		for _, r := range rs {
			m[r]++
		}
		return m
	}
	ka, kb := key(a), key(b)
	for r, n := range ka {
		if kb[r] != n {
			return false
		}
	}
	return true
}
