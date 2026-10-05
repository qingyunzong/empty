// Package rollup maintains day, week, and month counts from a raw event
// ledger. Events carry explicit integer days and months; weeks are derived
// from a fixed week origin, so no system timezone is ever involved.
package rollup

import (
	"errors"
	"fmt"
)

// ErrFault is returned when an injected fault interrupts a three-layer
// update, simulating a crash. The store is left partially updated and must
// be restored with Recover before further use.
var ErrFault = errors.New("rollup: injected fault")

// Event is a single raw occurrence recorded in the ledger.
type Event struct {
	ID    string // unique, stable identifier used for dedup and undo
	Day   int    // explicit integer day
	Month int    // explicit integer month
	Delta int64  // signed amount added to every layer
}

// Store keeps the raw event ledger plus three aggregate layers (day, week,
// month). The ledger is the source of truth; aggregates can always be
// rebuilt from it with Recover.
type Store struct {
	cal Calendar

	ledger []Event
	active map[string]int // event ID -> ledger index; only active events count

	days   map[int]int64
	weeks  map[int]int64
	months map[int]int64

	faultStep  int  // armed fault point: 1..3, 0 = disarmed
	faultFired bool // set when the armed fault triggered
}

// NewStore returns an empty store using cal for day-to-week mapping.
func NewStore(cal Calendar) *Store {
	s := &Store{cal: cal}
	s.Recover()
	return s
}

// InjectFault arms a one-shot fault that interrupts the next three-layer
// update after the given step: 1 = after the day layer, 2 = after the week
// layer, 3 = after the month layer. A step outside 1..3 disarms injection.
func (s *Store) InjectFault(step int) {
	s.faultStep = step
	s.faultFired = false
}

// FaultFired reports whether the armed fault has triggered.
func (s *Store) FaultFired() bool { return s.faultFired }

func (s *Store) checkFault(step int) error {
	if s.faultStep == step {
		s.faultStep = 0
		s.faultFired = true
		return ErrFault
	}
	return nil
}

// Apply records ev and adds its delta to all three layers. Replaying an
// event whose ID is already active is a no-op, so duplicates never count
// twice. The ledger is updated before the aggregate layers, so a fault
// mid-update can always be repaired by Recover.
func (s *Store) Apply(ev Event) error {
	if _, ok := s.active[ev.ID]; ok {
		return nil
	}
	s.active[ev.ID] = len(s.ledger)
	s.ledger = append(s.ledger, ev)
	return s.addToLayers(ev, ev.Delta)
}

// Undo reverses the event with the given ID, subtracting its delta from
// all three layers. Undoing an ID that is not active (unknown or already
// undone) returns an error.
func (s *Store) Undo(id string) error {
	idx, ok := s.active[id]
	if !ok {
		return fmt.Errorf("rollup: undo: no active event with id %q", id)
	}
	ev := s.ledger[idx]
	delete(s.active, id)
	return s.addToLayers(ev, -ev.Delta)
}

// addToLayers applies delta to the day, week, and month layers in order,
// honoring the armed fault point between layers.
func (s *Store) addToLayers(ev Event, delta int64) error {
	s.days[ev.Day] += delta
	if err := s.checkFault(1); err != nil {
		return err
	}
	s.weeks[s.cal.Week(ev.Day)] += delta
	if err := s.checkFault(2); err != nil {
		return err
	}
	s.months[ev.Month] += delta
	if err := s.checkFault(3); err != nil {
		return err
	}
	return nil
}

// Recover rebuilds all three aggregate layers from the raw ledger,
// replaying only active events. After a fault, Recover restores counts
// identical to a fault-free recompute of the same ledger.
func (s *Store) Recover() {
	s.days = make(map[int]int64)
	s.weeks = make(map[int]int64)
	s.months = make(map[int]int64)
	if s.active == nil {
		s.active = make(map[string]int)
	}
	for _, ev := range s.ledger {
		if _, ok := s.active[ev.ID]; !ok {
			continue
		}
		s.days[ev.Day] += ev.Delta
		s.weeks[s.cal.Week(ev.Day)] += ev.Delta
		s.months[ev.Month] += ev.Delta
	}
}

// Day returns the count for an explicit integer day.
func (s *Store) Day(day int) int64 { return s.days[day] }

// Week returns the count for a week index (see Calendar.Week).
func (s *Store) Week(week int) int64 { return s.weeks[week] }

// WeekOf returns the count for the week containing the given day.
func (s *Store) WeekOf(day int) int64 { return s.weeks[s.cal.Week(day)] }

// Month returns the count for an explicit integer month.
func (s *Store) Month(month int) int64 { return s.months[month] }

// Snapshot returns a copy of all three layers, for comparison.
// Zero-valued entries are omitted: a key with count 0 is semantically
// identical to an absent key.
func (s *Store) Snapshot() (days, weeks, months map[int]int64) {
	clone := func(m map[int]int64) map[int]int64 {
		out := make(map[int]int64, len(m))
		for k, v := range m {
			if v == 0 {
				continue
			}
			out[k] = v
		}
		return out
	}
	return clone(s.days), clone(s.weeks), clone(s.months)
}
