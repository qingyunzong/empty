package orderstats

import (
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }

func ev(id, order string, sec, version int, to State) Event {
	return Event{ID: id, Order: order, Time: at(sec), Version: version, To: to}
}

func TestSameTimeOrderedByVersionThenID(t *testing.T) {
	e := NewEngine()
	// All three events share a timestamp. Stream order is scrambled;
	// (version, ID) must decide: (1,"e2") -> (2,"e1") -> (2,"e3").
	// Only that order makes created -> paid -> packed all legal.
	e.Add(ev("e3", "o1", 10, 2, StatePacked))
	e.Add(ev("e1", "o1", 10, 2, StatePaid))
	e.Add(ev("e2", "o1", 10, 1, StateCreated))

	want := []Segment{
		{State: StateCreated, Start: at(10), End: at(10)},
		{State: StatePaid, Start: at(10), End: at(10)},
		{State: StatePacked, Start: at(10)},
	}
	if got := e.Timeline("o1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("timeline = %+v, want %+v", got, want)
	}
	if got := e.Rejections("o1"); len(got) != 0 {
		t.Fatalf("rejections = %+v, want none", got)
	}
}

func TestIllegalTransitionEvidenceAndNoEffect(t *testing.T) {
	e := NewEngine()
	e.Add(ev("e1", "o1", 10, 1, StateCreated))
	e.Add(ev("e2", "o1", 20, 1, StateDelivered)) // illegal: created -> delivered
	e.Add(ev("e3", "o1", 25, 1, State("bogus"))) // unknown target state
	e.Add(ev("e4", "o1", 30, 1, StatePaid))      // legal again

	wantTL := []Segment{
		{State: StateCreated, Start: at(10), End: at(30)},
		{State: StatePaid, Start: at(30)},
	}
	if got := e.Timeline("o1"); !reflect.DeepEqual(got, wantTL) {
		t.Fatalf("timeline = %+v, want %+v", got, wantTL)
	}

	rej := e.Rejections("o1")
	if len(rej) != 2 {
		t.Fatalf("len(rejections) = %d, want 2", len(rej))
	}
	if rej[0].Event.ID != "e2" || rej[0].From != StateCreated ||
		!strings.Contains(rej[0].Reason, `illegal transition "created" -> "delivered"`) {
		t.Fatalf("rejection[0] = %+v, want evidence for e2 created->delivered", rej[0])
	}
	if rej[1].Event.ID != "e3" || !strings.Contains(rej[1].Reason, `unknown target state "bogus"`) {
		t.Fatalf("rejection[1] = %+v, want evidence for e3 unknown state", rej[1])
	}
}

func TestCorrectionCanInvalidateSuccessors(t *testing.T) {
	e := NewEngine()
	e.Add(ev("e1", "o1", 10, 1, StateCreated))
	e.Add(ev("pay", "o1", 20, 1, StatePaid))
	e.Add(ev("e3", "o1", 30, 1, StatePacked))

	// Correction: "pay" now says cancelled. packed after cancelled is illegal.
	if !e.Add(ev("pay", "o1", 20, 2, StateCancelled)) {
		t.Fatal("correction was not applied")
	}

	wantTL := []Segment{
		{State: StateCreated, Start: at(10), End: at(20)},
		{State: StateCancelled, Start: at(20)},
	}
	if got := e.Timeline("o1"); !reflect.DeepEqual(got, wantTL) {
		t.Fatalf("timeline = %+v, want %+v", got, wantTL)
	}
	rej := e.Rejections("o1")
	if len(rej) != 1 || rej[0].Event.ID != "e3" || rej[0].From != StateCancelled {
		t.Fatalf("rejections = %+v, want e3 rejected from cancelled", rej)
	}
}

func TestCorrectionCanValidateSuccessors(t *testing.T) {
	e := NewEngine()
	e.Add(ev("e1", "o1", 10, 1, StateCreated))
	e.Add(ev("e2", "o1", 20, 1, StateShipped)) // illegal from created
	e.Add(ev("e3", "o1", 30, 1, StatePacked))  // illegal while still created

	// Correction: e2 becomes paid, making e3 legal too.
	e.Add(ev("e2", "o1", 20, 2, StatePaid))

	wantTL := []Segment{
		{State: StateCreated, Start: at(10), End: at(20)},
		{State: StatePaid, Start: at(20), End: at(30)},
		{State: StatePacked, Start: at(30)},
	}
	if got := e.Timeline("o1"); !reflect.DeepEqual(got, wantTL) {
		t.Fatalf("timeline = %+v, want %+v", got, wantTL)
	}
	if got := e.Rejections("o1"); len(got) != 0 {
		t.Fatalf("rejections = %+v, want none after correction", got)
	}
}

func TestStaleVersionIgnored(t *testing.T) {
	e := NewEngine()
	e.Add(ev("e1", "o1", 10, 1, StateCreated))
	e.Add(ev("e2", "o1", 20, 1, StatePaid))
	e.Add(ev("e2", "o1", 20, 2, StateCancelled)) // correction to v2
	if e.Add(ev("e2", "o1", 20, 2, StatePacked)) {
		t.Fatal("equal version should be stale")
	}
	if e.Add(ev("e2", "o1", 20, 1, StatePacked)) {
		t.Fatal("lower version should be stale")
	}
	want := []Segment{
		{State: StateCreated, Start: at(10), End: at(20)},
		{State: StateCancelled, Start: at(20)},
	}
	if got := e.Timeline("o1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("timeline = %+v, want %+v", got, want)
	}
}

func TestResidencyHalfOpen(t *testing.T) {
	tl := []Segment{
		{State: StateCreated, Start: at(0), End: at(10)},
		{State: StatePaid, Start: at(10), End: at(25)},
		{State: StateDelivered, Start: at(25)}, // open-ended
	}
	sec := time.Second

	// Boundary instants belong to the segment that starts there.
	if !tl[0].Contains(at(0)) || tl[0].Contains(at(10)) || !tl[1].Contains(at(10)) {
		t.Fatal("segment Contains is not half-open [Start, End)")
	}

	cases := []struct {
		from, to int
		want     map[State]time.Duration
	}{
		{0, 10, map[State]time.Duration{StateCreated: 10 * sec}},
		{10, 25, map[State]time.Duration{StatePaid: 15 * sec}},
		{5, 30, map[State]time.Duration{StateCreated: 5 * sec, StatePaid: 15 * sec, StateDelivered: 5 * sec}},
		{10, 10, map[State]time.Duration{}}, // empty interval
		{25, 100, map[State]time.Duration{StateDelivered: 75 * sec}},
	}
	for _, c := range cases {
		if got := Residency(tl, at(c.from), at(c.to)); !reflect.DeepEqual(got, c.want) {
			t.Fatalf("Residency([%d,%d)) = %v, want %v", c.from, c.to, got, c.want)
		}
	}
}

// TestIncrementalMatchesFullReplay feeds a randomized stream (including
// corrections, stale versions, illegal and unknown transitions, and
// colliding timestamps) and, after every single increment, verifies the
// engine against a full replay of the raw stream.
func TestIncrementalMatchesFullReplay(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	states := []State{
		StateCreated, StatePaid, StatePacked, StateShipped,
		StateDelivered, StateCancelled, StateReturned, State("bogus"),
	}
	raw := map[string][]Event{}
	maxVersion := map[string]int{}
	eng := NewEngine()

	for i := 0; i < 400; i++ {
		order := fmt.Sprintf("order-%d", rng.Intn(6))
		var event Event
		switch {
		case len(raw[order]) > 0 && rng.Intn(4) == 0: // correction
			pick := raw[order][rng.Intn(len(raw[order]))]
			maxVersion[pick.ID]++
			event = Event{
				ID:      pick.ID,
				Order:   order,
				Time:    at(rng.Intn(120)),
				Version: maxVersion[pick.ID],
				To:      states[rng.Intn(len(states))],
			}
		default: // new event
			id := fmt.Sprintf("ev-%d", i)
			maxVersion[id] = 1
			event = Event{
				ID:      id,
				Order:   order,
				Time:    at(rng.Intn(120)),
				Version: 1,
				To:      states[rng.Intn(len(states))],
			}
		}
		raw[order] = append(raw[order], event)
		eng.Add(event)

		wantTL, wantRej := Replay(raw[order])
		if got := eng.Timeline(order); !reflect.DeepEqual(got, wantTL) {
			t.Fatalf("step %d (%s): timeline = %+v, want %+v", i, order, got, wantTL)
		}
		if got := eng.Rejections(order); !reflect.DeepEqual(got, wantRej) {
			t.Fatalf("step %d (%s): rejections = %+v, want %+v", i, order, got, wantRej)
		}
	}

	// Residency over random windows must match the replayed timelines too.
	for order, events := range raw {
		wantTL, _ := Replay(events)
		for w := 0; w < 20; w++ {
			from, to := at(rng.Intn(120)), at(rng.Intn(120))
			if to.Before(from) {
				from, to = to, from
			}
			if got, want := eng.Residency(order, from, to), Residency(wantTL, from, to); !reflect.DeepEqual(got, want) {
				t.Fatalf("%s residency [%v,%v) = %v, want %v", order, from, to, got, want)
			}
		}
	}
}
