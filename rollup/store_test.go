package rollup

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func TestCalendarWeekOrigin(t *testing.T) {
	c := Calendar{WeekOrigin: 3}
	cases := []struct{ day, week int }{
		{3, 0}, {9, 0}, // first week starts exactly at the origin
		{10, 1}, {16, 1},
		{2, -1}, {-4, -1}, // floor division before the origin
		{-5, -2},
	}
	for _, tc := range cases {
		if got := c.Week(tc.day); got != tc.week {
			t.Errorf("Week(%d) with origin 3 = %d, want %d", tc.day, got, tc.week)
		}
	}
	if (Calendar{}).Week(13) != 1 {
		t.Errorf("zero origin: Week(13) = %d, want 1", (Calendar{}).Week(13))
	}
}

func TestDayWeekMonthCounts(t *testing.T) {
	s := NewStore(Calendar{WeekOrigin: 0})
	events := []Event{
		{ID: "a", Day: 0, Month: 0, Delta: 2},
		{ID: "b", Day: 6, Month: 0, Delta: 3},
		{ID: "c", Day: 7, Month: 0, Delta: 5},
		{ID: "d", Day: 40, Month: 1, Delta: 1},
	}
	for _, ev := range events {
		if err := s.Apply(ev); err != nil {
			t.Fatalf("Apply(%+v): %v", ev, err)
		}
	}
	if got := s.Day(0); got != 2 {
		t.Errorf("Day(0) = %d, want 2", got)
	}
	if got := s.Week(0); got != 5 {
		t.Errorf("Week(0) = %d, want 5", got)
	}
	if got := s.WeekOf(7); got != 5 {
		t.Errorf("WeekOf(7) = %d, want 5", got)
	}
	if got := s.WeekOf(40); got != 1 {
		t.Errorf("WeekOf(40) = %d, want 1", got)
	}
	if got := s.Month(0); got != 10 {
		t.Errorf("Month(0) = %d, want 10", got)
	}
	if got := s.Month(1); got != 1 {
		t.Errorf("Month(1) = %d, want 1", got)
	}
}

func TestDuplicateReplayCountsOnce(t *testing.T) {
	s := NewStore(Calendar{})
	ev := Event{ID: "dup", Day: 3, Month: 1, Delta: 7}
	for i := 0; i < 3; i++ {
		if err := s.Apply(ev); err != nil {
			t.Fatalf("replay %d: %v", i, err)
		}
	}
	if got := s.Day(3); got != 7 {
		t.Errorf("Day(3) = %d, want 7 after replays", got)
	}
	if got := s.WeekOf(3); got != 7 {
		t.Errorf("WeekOf(3) = %d, want 7 after replays", got)
	}
	if got := s.Month(1); got != 7 {
		t.Errorf("Month(1) = %d, want 7 after replays", got)
	}
}

func TestUndo(t *testing.T) {
	s := NewStore(Calendar{})
	if err := s.Apply(Event{ID: "x", Day: 1, Month: 0, Delta: 4}); err != nil {
		t.Fatal(err)
	}
	if err := s.Apply(Event{ID: "y", Day: 1, Month: 0, Delta: 2}); err != nil {
		t.Fatal(err)
	}
	if err := s.Undo("x"); err != nil {
		t.Fatalf("Undo(x): %v", err)
	}
	if got := s.Day(1); got != 2 {
		t.Errorf("Day(1) = %d, want 2 after undo", got)
	}
	if got := s.Month(0); got != 2 {
		t.Errorf("Month(0) = %d, want 2 after undo", got)
	}
	if err := s.Undo("missing"); err == nil {
		t.Error("Undo of unknown ID: want error, got nil")
	}
	if err := s.Undo("x"); err == nil {
		t.Error("double Undo: want error, got nil")
	}
}

// script builds a deterministic mix of applies, replays, and undos.
func script() []Event {
	var evs []Event
	for i := 0; i < 40; i++ {
		evs = append(evs, Event{
			ID:    fmt.Sprintf("ev-%02d", i),
			Day:   (i*7 - 20) % 31,
			Month: (i * 3) % 5,
			Delta: int64(i%5 + 1),
		})
	}
	return evs
}

func replayOps(t *testing.T, s *Store, faultAtOp, faultStep int) {
	t.Helper()
	evs := script()
	op := 0
	apply := func(ev Event) {
		if op == faultAtOp {
			s.InjectFault(faultStep)
		}
		op++
		if err := s.Apply(ev); err != nil && !errors.Is(err, ErrFault) {
			t.Fatalf("Apply(%+v): %v", ev, err)
		}
	}
	undo := func(id string) {
		if op == faultAtOp {
			s.InjectFault(faultStep)
		}
		op++
		if err := s.Undo(id); err != nil && !errors.Is(err, ErrFault) {
			t.Fatalf("Undo(%q): %v", id, err)
		}
	}
	for i, ev := range evs {
		apply(ev)
		if i%3 == 0 {
			apply(ev) // duplicate replay must be a no-op
		}
		if i%4 == 1 {
			undo(evs[i-1].ID)
		}
	}
}

func referenceSnapshot(t *testing.T) (map[int]int64, map[int]int64, map[int]int64) {
	t.Helper()
	ref := NewStore(Calendar{WeekOrigin: 2})
	replayOps(t, ref, -1, 0)
	return ref.Snapshot()
}

func TestFaultInjectionRecovery(t *testing.T) {
	wantD, wantW, wantM := referenceSnapshot(t)
	for step := 1; step <= 3; step++ {
		for _, op := range []int{0, 5, 17, 42, 62} {
			t.Run(fmt.Sprintf("step%d/op%d", step, op), func(t *testing.T) {
				s := NewStore(Calendar{WeekOrigin: 2})
				replayOps(t, s, op, step)
				if !s.FaultFired() {
					t.Fatalf("fault at step %d op %d never fired", step, op)
				}
				s.Recover()
				gotD, gotW, gotM := s.Snapshot()
				if !reflect.DeepEqual(gotD, wantD) {
					t.Errorf("days differ after Recover")
				}
				if !reflect.DeepEqual(gotW, wantW) {
					t.Errorf("weeks differ after Recover")
				}
				if !reflect.DeepEqual(gotM, wantM) {
					t.Errorf("months differ after Recover")
				}
			})
		}
	}
}

func TestRecoverMatchesLedgerRecompute(t *testing.T) {
	s := NewStore(Calendar{WeekOrigin: 2})
	replayOps(t, s, -1, 0)
	beforeD, beforeW, beforeM := s.Snapshot()
	s.Recover()
	afterD, afterW, afterM := s.Snapshot()
	if !reflect.DeepEqual(beforeD, afterD) ||
		!reflect.DeepEqual(beforeW, afterW) ||
		!reflect.DeepEqual(beforeM, afterM) {
		t.Error("Recover on a healthy store changed the counts")
	}
}
