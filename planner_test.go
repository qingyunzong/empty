package occupancy

import "testing"

func mustAdd(t *testing.T, p *Planner, id string, res []Reservation) {
	t.Helper()
	if err := p.AddTrain(id, res); err != nil {
		t.Fatalf("AddTrain(%s): %v", id, err)
	}
}

func TestHalfOpenOverlap(t *testing.T) {
	a := Reservation{Track: 1, Start: 0, End: 5}
	if a.Overlaps(Reservation{Track: 1, Start: 5, End: 9}) {
		t.Error("intervals touching at endpoint 5 must not conflict (half-open)")
	}
	if !a.Overlaps(Reservation{Track: 1, Start: 4, End: 6}) {
		t.Error("[0,5) and [4,6) on the same track must conflict")
	}
	if a.Overlaps(Reservation{Track: 2, Start: 1, End: 4}) {
		t.Error("overlapping times on different tracks must not conflict")
	}
}

func TestAddTrainRejectsInvalid(t *testing.T) {
	p := New()
	if err := p.AddTrain("bad", []Reservation{{Track: 0, Start: 5, End: 5}}); err == nil {
		t.Error("empty interval accepted")
	}
	if err := p.AddTrain("bad", []Reservation{{Track: 0, Start: 0, End: MaxTime + 1}}); err == nil {
		t.Error("interval beyond time domain accepted")
	}
	if err := p.AddTrain("bad", []Reservation{{Track: 0, Start: 0, End: 4}, {Track: 0, Start: 3, End: 8}}); err == nil {
		t.Error("self-overlapping reservations accepted")
	}
	mustAdd(t, p, "a", []Reservation{{Track: 0, Start: 0, End: 10}})
	if err := p.AddTrain("b", []Reservation{{Track: 0, Start: 9, End: 12}}); err == nil {
		t.Error("conflicting train accepted")
	}
	if err := p.AddTrain("b", []Reservation{{Track: 1, Start: 9, End: 12}}); err != nil {
		t.Errorf("same time on a different track must be fine: %v", err)
	}
}

func TestRescheduleExcludesOwnOld(t *testing.T) {
	p := New()
	mustAdd(t, p, "t", []Reservation{{Track: 0, Start: 10, End: 20}})
	// The new plan overlaps the train's own old plan; that must not count
	// as a conflict because the old reservations are removed first.
	if !p.Reschedule("t", []Reservation{{Track: 0, Start: 15, End: 25}}) {
		t.Fatal("reschedule overlapping only its own old plan must succeed")
	}
	got := p.Reservations("t")
	if len(got) != 1 || got[0].Start != 15 || got[0].End != 25 {
		t.Fatalf("unexpected plan after reschedule: %+v", got)
	}
}

func TestRescheduleKeepsOldOnFailure(t *testing.T) {
	p := New()
	mustAdd(t, p, "a", []Reservation{{Track: 0, Start: 0, End: 10}})
	mustAdd(t, p, "b", []Reservation{{Track: 0, Start: 20, End: 30}})
	if p.Reschedule("b", []Reservation{{Track: 0, Start: 5, End: 15}}) {
		t.Fatal("conflicting reschedule must fail")
	}
	got := p.Reservations("b")
	if len(got) != 1 || got[0].Start != 20 || got[0].End != 30 {
		t.Fatalf("old plan not preserved after failed reschedule: %+v", got)
	}
	if p.Reschedule("b", []Reservation{{Track: 0, Start: 40, End: MaxTime + 1}}) {
		t.Fatal("out-of-domain reschedule must fail")
	}
	if got := p.Reservations("b"); got[0].Start != 20 {
		t.Fatalf("old plan not preserved after invalid reschedule: %+v", got)
	}
}

func TestShift(t *testing.T) {
	p := New()
	mustAdd(t, p, "a", []Reservation{{Track: 0, Start: 0, End: 10}})
	mustAdd(t, p, "b", []Reservation{{Track: 0, Start: 10, End: 20}, {Track: 1, Start: 30, End: 35}})
	if p.Shift("b", -40) {
		t.Fatal("shift leaving the time domain must fail")
	}
	if p.Shift("b", -10) {
		t.Fatal("shift onto another train must fail")
	}
	if got := p.Reservations("b"); got[0].Start != 10 {
		t.Fatalf("old plan not preserved: %+v", got)
	}
	if !p.Shift("b", 20) {
		t.Fatal("feasible whole shift must succeed")
	}
	got := p.Reservations("b")
	want := []Reservation{{Track: 0, Start: 30, End: 40}, {Track: 1, Start: 50, End: 55}}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("shifted plan = %+v, want %+v", got, want)
		}
	}
}
