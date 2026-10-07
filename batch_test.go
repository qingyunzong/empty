package railplan

import (
	"errors"
	"fmt"
	"testing"
)

func TestAtomicSwap(t *testing.T) {
	p := New()
	// A and B occupy adjacent slots on the same track.
	if err := p.Add("A", []Reservation{res("T1", 0, 10)}); err != nil {
		t.Fatal(err)
	}
	if err := p.Add("B", []Reservation{res("T1", 10, 20)}); err != nil {
		t.Fatal(err)
	}
	// Individually each new layout collides with the other's old one;
	// as one atomic batch the swap succeeds.
	swap := map[string][]Reservation{
		"A": {res("T1", 10, 20)},
		"B": {res("T1", 0, 10)},
	}
	if err := p.AtomicReschedule(swap); err != nil {
		t.Fatalf("atomic swap must succeed: %v", err)
	}
	if got := p.Reservations("A"); !sameLayout(got, []Reservation{res("T1", 10, 20)}) {
		t.Fatalf("A layout = %v", got)
	}
	if got := p.Reservations("B"); !sameLayout(got, []Reservation{res("T1", 0, 10)}) {
		t.Fatalf("B layout = %v", got)
	}
}

func TestAtomicBatchFailureKeepsWholeOldLayout(t *testing.T) {
	p := New()
	must := func(train string, layout []Reservation) {
		t.Helper()
		if err := p.Add(train, layout); err != nil {
			t.Fatal(err)
		}
	}
	must("A", []Reservation{res("T1", 0, 10)})
	must("B", []Reservation{res("T1", 10, 20)})
	must("C", []Reservation{res("T1", 50, 60)})

	oldA, oldB := p.Reservations("A"), p.Reservations("B")
	// A's new layout is fine on its own, but B's collides with outsider C:
	// the whole batch must be rejected and nothing may change.
	batch := map[string][]Reservation{
		"A": {res("T1", 30, 40)},
		"B": {res("T1", 55, 65)},
	}
	if err := p.AtomicReschedule(batch); err == nil {
		t.Fatal("expected batch to fail against outsider C")
	}
	if got := p.Reservations("A"); !sameLayout(got, oldA) {
		t.Fatalf("failed batch must keep A old layout: %v", got)
	}
	if got := p.Reservations("B"); !sameLayout(got, oldB) {
		t.Fatalf("failed batch must keep B old layout: %v", got)
	}

	// New layouts inside the batch conflict with each other.
	clash := map[string][]Reservation{
		"A": {res("T1", 30, 40)},
		"B": {res("T1", 35, 45)},
	}
	if err := p.AtomicReschedule(clash); err == nil {
		t.Fatal("expected in-batch conflict to fail")
	}
	if got := p.Reservations("A"); !sameLayout(got, oldA) {
		t.Fatalf("failed batch must keep A old layout: %v", got)
	}
}

func TestIntentSuccess(t *testing.T) {
	p := New()
	if err := p.Add("A", []Reservation{res("T1", 0, 10)}); err != nil {
		t.Fatal(err)
	}
	if err := p.Add("B", []Reservation{res("T1", 10, 20)}); err != nil {
		t.Fatal(err)
	}
	it := NewIntent(map[string][]Reservation{
		"A": {res("T1", 10, 20)},
		"B": {res("T1", 0, 10)},
	})
	if err := it.Execute(p); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	it.Recover(p) // no-op after success
	if got := p.Reservations("A"); !sameLayout(got, []Reservation{res("T1", 10, 20)}) {
		t.Fatalf("A layout = %v", got)
	}
}

// TestIntentRecoveryNeverPartial crashes the intent at every execution
// step, under both commit placements, and verifies the planner always
// ends in either the whole old or the whole new batch layout.
func TestIntentRecoveryNeverPartial(t *testing.T) {
	newLayout := map[string][]Reservation{
		"A": {res("T1", 20, 30)},
		"B": {res("T1", 30, 40)},
		"C": {res("T1", 40, 50)},
	}
	for _, commitAfter := range []int{0, len(newLayout)} {
		for crashAt := 0; crashAt <= 2*len(newLayout)+3; crashAt++ {
			name := fmt.Sprintf("commitAfter=%d/crashAt=%d", commitAfter, crashAt)
			t.Run(name, func(t *testing.T) {
				p := New()
				oldLayout := map[string][]Reservation{
					"A": {res("T1", 0, 10)},
					"B": {res("T1", 10, 20)},
					"C": {res("T1", 60, 70)},
				}
				for train, layout := range oldLayout {
					if err := p.Add(train, layout); err != nil {
						t.Fatal(err)
					}
				}
				it := NewIntent(newLayout)
				it.CommitAfter = commitAfter
				it.CrashAt = crashAt
				err := it.Execute(p)
				if err != nil && !errors.Is(err, ErrCrash) {
					t.Fatalf("unexpected error: %v", err)
				}
				it.Recover(p)

				allOld, allNew := true, true
				for _, train := range []string{"A", "B", "C"} {
					got := p.Reservations(train)
					if !sameLayout(got, oldLayout[train]) {
						allOld = false
					}
					if !sameLayout(got, newLayout[train]) {
						allNew = false
					}
				}
				if !allOld && !allNew {
					got := map[string][]Reservation{}
					for train := range oldLayout {
						got[train] = p.Reservations(train)
					}
					t.Fatalf("recovery left a partial batch: %v", got)
				}
				// Direction must follow the commit record.
				if it.committed && !allNew {
					t.Fatal("committed intent must roll forward to the new layout")
				}
				if !it.committed && !allOld {
					t.Fatal("uncommitted intent must roll back to the old layout")
				}
			})
		}
	}
}

func TestIntentInvalidBatchKeepsOld(t *testing.T) {
	p := New()
	if err := p.Add("A", []Reservation{res("T1", 0, 10)}); err != nil {
		t.Fatal(err)
	}
	if err := p.Add("B", []Reservation{res("T1", 50, 60)}); err != nil {
		t.Fatal(err)
	}
	oldA, oldB := p.Reservations("A"), p.Reservations("B")
	// B stays outside the batch, so A's new layout collides with it.
	it := NewIntent(map[string][]Reservation{
		"A": {res("T1", 55, 65)},
	})
	if err := it.Execute(p); err == nil || errors.Is(err, ErrCrash) {
		t.Fatalf("expected validation error, got %v", err)
	}
	it.Recover(p)
	if got := p.Reservations("A"); !sameLayout(got, oldA) {
		t.Fatalf("A layout = %v", got)
	}
	if got := p.Reservations("B"); !sameLayout(got, oldB) {
		t.Fatalf("B layout = %v", got)
	}
}
