package rollup

import (
	"errors"
	"fmt"
)

// ErrEventNotFound is returned by Undo when the given event ID is not
// present in the ledger.
var ErrEventNotFound = errors.New("rollup: event not found")

// Event is a raw occurrence to be counted. Day is an explicit integer
// day (days since 1970-01-01); the calendar never uses the system
// timezone.
type Event struct {
	ID  string
	Day int
}

// Store maintains daily, weekly, and monthly counts derived from a
// durable ledger of raw events. The ledger is the source of truth;
// the three count layers are materialized views that Recover can
// always rebuild.
type Store struct {
	weekOrigin int

	ledger map[string]Event
	order  []string

	days   map[int]int
	weeks  map[int]int
	months map[Month]int

	// Faults, when non-nil, can inject crashes into Apply.
	Faults *FaultInjector
}

// NewStore creates an empty Store whose week boundaries are anchored
// at the explicit weekOrigin day (week 0 contains weekOrigin).
func NewStore(weekOrigin int) *Store {
	return &Store{
		weekOrigin: weekOrigin,
		ledger:     make(map[string]Event),
		days:       make(map[int]int),
		weeks:      make(map[int]int),
		months:     make(map[Month]int),
	}
}

// WeekOrigin returns the explicit day on which week 0 starts.
func (s *Store) WeekOrigin() int {
	return s.weekOrigin
}

// Apply records ev in the durable ledger and updates the three count
// layers. Replaying an event whose ID is already recorded is a no-op
// and reports applied=false, so duplicate replays never double count.
//
// If a fault is injected mid-update, Apply returns an error and the
// count layers may be left partially updated; call Recover to rebuild
// them from the ledger.
func (s *Store) Apply(ev Event) (applied bool, err error) {
	if _, ok := s.ledger[ev.ID]; ok {
		return false, nil
	}
	s.ledger[ev.ID] = ev
	s.order = append(s.order, ev.ID)

	if err := s.checkFault(LayerDay); err != nil {
		return true, err
	}
	s.days[ev.Day]++

	if err := s.checkFault(LayerWeek); err != nil {
		return true, err
	}
	s.weeks[WeekIndex(ev.Day, s.weekOrigin)]++

	if err := s.checkFault(LayerMonth); err != nil {
		return true, err
	}
	s.months[MonthOf(ev.Day)]++

	return true, nil
}

func (s *Store) checkFault(layer Layer) error {
	if s.Faults == nil {
		return nil
	}
	return s.Faults.check(layer)
}

// Replay applies a batch of events in order. Already-recorded IDs are
// skipped, so replaying the same batch is safe. It stops at the first
// injected fault.
func (s *Store) Replay(events []Event) error {
	for _, ev := range events {
		if _, err := s.Apply(ev); err != nil {
			return err
		}
	}
	return nil
}

// Undo removes the event with the given ID from the ledger and
// decrements its counts in all three layers. It returns
// ErrEventNotFound if the ID is not recorded. Undo requires the count
// layers to be consistent; call Recover first if a fault may have
// left them partially updated.
func (s *Store) Undo(id string) error {
	ev, ok := s.ledger[id]
	if !ok {
		return fmt.Errorf("%w: %q", ErrEventNotFound, id)
	}
	delete(s.ledger, id)
	for i, oid := range s.order {
		if oid == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	decrement(s.days, ev.Day)
	decrement(s.weeks, WeekIndex(ev.Day, s.weekOrigin))
	decrement(s.months, MonthOf(ev.Day))
	return nil
}

func decrement[K comparable](m map[K]int, key K) {
	if m[key] <= 1 {
		delete(m, key)
		return
	}
	m[key]--
}

// Recover rebuilds the daily, weekly, and monthly counts from the raw
// ledger, discarding any partially updated or corrupted layers. The
// result is identical to replaying the ledger into a fresh store.
func (s *Store) Recover() {
	s.days = make(map[int]int)
	s.weeks = make(map[int]int)
	s.months = make(map[Month]int)
	for _, id := range s.order {
		ev := s.ledger[id]
		s.days[ev.Day]++
		s.weeks[WeekIndex(ev.Day, s.weekOrigin)]++
		s.months[MonthOf(ev.Day)]++
	}
}

// DayCount returns the count for the given integer day.
func (s *Store) DayCount(day int) int {
	return s.days[day]
}

// WeekCount returns the count for the week containing the given day.
func (s *Store) WeekCount(day int) int {
	return s.weeks[WeekIndex(day, s.weekOrigin)]
}

// MonthCount returns the count for the civil month containing the
// given day.
func (s *Store) MonthCount(day int) int {
	return s.months[MonthOf(day)]
}

// Len returns the number of events currently recorded in the ledger.
func (s *Store) Len() int {
	return len(s.ledger)
}

// Events returns the recorded events in insertion order.
func (s *Store) Events() []Event {
	out := make([]Event, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.ledger[id])
	}
	return out
}
