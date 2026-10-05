package rollup

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestApplyIdempotentReplay(t *testing.T) {
	s := NewStore(0)
	ev := Event{ID: "e1", Day: 10}

	applied, err := s.Apply(ev)
	if err != nil || !applied {
		t.Fatalf("first apply: applied=%v err=%v", applied, err)
	}
	applied, err = s.Apply(ev)
	if err != nil {
		t.Fatalf("replay returned error: %v", err)
	}
	if applied {
		t.Fatal("duplicate replay reported applied=true")
	}
	if s.Len() != 1 {
		t.Fatalf("ledger len = %d, want 1", s.Len())
	}
	if got := s.DayCount(10); got != 1 {
		t.Fatalf("day count = %d, want 1 (double count on replay)", got)
	}
	if got := s.WeekCount(10); got != 1 {
		t.Fatalf("week count = %d, want 1", got)
	}
	if got := s.MonthCount(10); got != 1 {
		t.Fatalf("month count = %d, want 1", got)
	}

	batch := []Event{{ID: "a", Day: 1}, {ID: "b", Day: 2}, {ID: "c", Day: 2}}
	if err := s.Replay(batch); err != nil {
		t.Fatal(err)
	}
	if err := s.Replay(batch); err != nil {
		t.Fatal(err)
	}
	if got := s.DayCount(2); got != 2 {
		t.Fatalf("day count after batch replay = %d, want 2", got)
	}
	if s.Len() != 4 {
		t.Fatalf("ledger len = %d, want 4", s.Len())
	}
}

func TestUndoMissingID(t *testing.T) {
	s := NewStore(0)
	if err := s.Undo("nope"); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("undo missing ID: err = %v, want ErrEventNotFound", err)
	}
	if err := s.Replay([]Event{{ID: "x", Day: 5}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Undo("other"); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("undo unknown ID: err = %v, want ErrEventNotFound", err)
	}
}

func TestUndoRemovesCounts(t *testing.T) {
	s := NewStore(0)
	events := []Event{
		{ID: "a", Day: 10},
		{ID: "b", Day: 10},
		{ID: "c", Day: 12},
	}
	if err := s.Replay(events); err != nil {
		t.Fatal(err)
	}
	if err := s.Undo("a"); err != nil {
		t.Fatal(err)
	}
	if got := s.DayCount(10); got != 1 {
		t.Fatalf("day count = %d, want 1", got)
	}
	if got := s.WeekCount(10); got != 2 {
		t.Fatalf("week count = %d, want 2", got)
	}
	if got := s.MonthCount(10); got != 2 {
		t.Fatalf("month count = %d, want 2", got)
	}
	if err := s.Undo("b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Undo("c"); err != nil {
		t.Fatal(err)
	}
	if s.Len() != 0 {
		t.Fatalf("ledger len = %d, want 0", s.Len())
	}
	for day := 0; day < 20; day++ {
		if s.DayCount(day) != 0 || s.WeekCount(day) != 0 || s.MonthCount(day) != 0 {
			t.Fatalf("residual count at day %d", day)
		}
	}
	if err := s.Undo("a"); !errors.Is(err, ErrEventNotFound) {
		t.Fatalf("re-undo: err = %v, want ErrEventNotFound", err)
	}
}

func TestWeekOrigin(t *testing.T) {
	cases := []struct {
		day, origin, want int
	}{
		{0, 0, 0}, {6, 0, 0}, {7, 0, 1}, {13, 0, 1}, {14, 0, 2},
		{-1, 0, -1}, {-7, 0, -1}, {-8, 0, -2},
		{2, 2, 0}, {8, 2, 0}, {9, 2, 1}, {1, 2, -1},
		{-5, 2, -1}, {-6, 2, -2},
	}
	for _, c := range cases {
		if got := WeekIndex(c.day, c.origin); got != c.want {
			t.Errorf("WeekIndex(%d, %d) = %d, want %d", c.day, c.origin, got, c.want)
		}
	}
}

func TestMonthCalendar(t *testing.T) {
	cases := []struct {
		day  int
		want Month
	}{
		{0, Month{1970, 1}},
		{30, Month{1970, 1}},
		{31, Month{1970, 2}},
		{58, Month{1970, 2}},
		{59, Month{1970, 3}},
		{364, Month{1970, 12}},
		{365, Month{1971, 1}},
		{-1, Month{1969, 12}},
		{-31, Month{1969, 12}},
		{-32, Month{1969, 11}},
		{10956, Month{1999, 12}}, // 1999-12-31
		{10957, Month{2000, 1}},  // 2000-01-01
		{11015, Month{2000, 2}},  // 2000-02-28
		{11016, Month{2000, 2}},  // 2000-02-29 (leap)
		{11017, Month{2000, 3}},  // 2000-03-01
		{18261, Month{2019, 12}}, // 2019-12-31
		{18262, Month{2020, 1}},  // 2020-01-01
	}
	for _, c := range cases {
		if got := MonthOf(c.day); got != c.want {
			t.Errorf("MonthOf(%d) = %v, want %v", c.day, got, c.want)
		}
	}
}

// countsEqual compares two stores' materialized layers.
func countsEqual(a, b *Store) bool {
	return reflect.DeepEqual(a.days, b.days) &&
		reflect.DeepEqual(a.weeks, b.weeks) &&
		reflect.DeepEqual(a.months, b.months)
}

func TestFaultInjectionRecovery(t *testing.T) {
	base := []Event{
		{ID: "e1", Day: 0},
		{ID: "e2", Day: 7},
		{ID: "e3", Day: 40},
	}
	for _, layer := range []Layer{LayerDay, LayerWeek, LayerMonth} {
		t.Run(fmt.Sprintf("layer%d", layer), func(t *testing.T) {
			s := NewStore(0)
			s.Faults = &FaultInjector{}
			if err := s.Replay(base); err != nil {
				t.Fatal(err)
			}

			s.Faults.Arm(layer)
			_, err := s.Apply(Event{ID: "e4", Day: 41})
			if !errors.Is(err, ErrInjectedFault) {
				t.Fatalf("err = %v, want ErrInjectedFault", err)
			}
			if s.Len() != 4 {
				t.Fatalf("event lost from ledger: len = %d, want 4", s.Len())
			}

			// Reference: fresh replay of the same ledger, no faults.
			ref := NewStore(0)
			if err := ref.Replay(s.Events()); err != nil {
				t.Fatal(err)
			}
			if countsEqual(s, ref) {
				t.Fatal("fault at this layer left no partial state; test is vacuous")
			}

			s.Recover()
			if !countsEqual(s, ref) {
				t.Fatal("recovered counts differ from ledger recomputation")
			}
		})
	}
}

func TestRandomizedRecoveryConsistency(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	s := NewStore(0)
	s.Faults = &FaultInjector{}
	nextID := 0

	for step := 0; step < 2000; step++ {
		switch rng.Intn(10) {
		case 0, 1, 2, 3, 4, 5: // apply, sometimes with an armed fault
			if rng.Intn(4) == 0 {
				s.Faults.Arm(Layer(rng.Intn(3)))
			}
			ev := Event{ID: fmt.Sprintf("e%d", nextID), Day: rng.Intn(2000) - 1000}
			nextID++
			_, err := s.Apply(ev)
			if errors.Is(err, ErrInjectedFault) {
				s.Recover()
			} else if err != nil {
				t.Fatal(err)
			}
		case 6, 7: // duplicate replay of a random recorded event
			if events := s.Events(); len(events) > 0 {
				ev := events[rng.Intn(len(events))]
				applied, err := s.Apply(ev)
				if err != nil {
					t.Fatal(err)
				}
				if applied {
					t.Fatalf("duplicate replay of %q counted twice", ev.ID)
				}
			}
		case 8: // undo a random recorded event
			if events := s.Events(); len(events) > 0 {
				if err := s.Undo(events[rng.Intn(len(events))].ID); err != nil {
					t.Fatal(err)
				}
			}
		case 9: // undo a missing ID must fail
			if err := s.Undo(fmt.Sprintf("missing-%d", step)); !errors.Is(err, ErrEventNotFound) {
				t.Fatalf("undo missing ID: err = %v", err)
			}
		}
	}

	// Final state must equal a fresh replay of the remaining ledger.
	ref := NewStore(0)
	if err := ref.Replay(s.Events()); err != nil {
		t.Fatal(err)
	}
	if !countsEqual(s, ref) {
		t.Fatal("final counts differ from ledger recomputation")
	}
	if s.Faults.Injected() == 0 {
		t.Fatal("no faults were injected; test is vacuous")
	}
	t.Logf("injected faults: %d, final ledger size: %d", s.Faults.Injected(), s.Len())
}
