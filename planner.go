// Package railplan implements a track-occupancy planning library.
//
// A train reserves several half-open intervals [Start, End) on named
// tracks. Two reservations conflict only when they share a track and
// their intervals overlap. The time domain is [0, MaxTime).
package railplan

import (
	"fmt"
	"sort"
)

// MaxTime is the exclusive upper bound of the planning time domain.
const MaxTime = 1000

// Interval is a half-open time interval [Start, End).
type Interval struct {
	Start, End int
}

// Valid reports whether the interval is non-empty and inside the domain.
func (iv Interval) Valid() bool { return 0 <= iv.Start && iv.Start < iv.End && iv.End <= MaxTime }

// Overlaps reports whether two half-open intervals share any moment.
func (iv Interval) Overlaps(o Interval) bool { return iv.Start < o.End && o.Start < iv.End }

// Shift returns the interval translated by d.
func (iv Interval) Shift(d int) Interval { return Interval{iv.Start + d, iv.End + d} }

// Reservation is one occupied half-open interval on a track.
type Reservation struct {
	Track string
	Span  Interval
}

// Shift returns the reservation translated by d in time.
func (r Reservation) Shift(d int) Reservation {
	return Reservation{Track: r.Track, Span: r.Span.Shift(d)}
}

// ConflictError reports that a reservation overlaps reservations of other trains.
type ConflictError struct {
	Track  string
	Span   Interval
	Others []string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("railplan: %s %v conflicts with %v", e.Track, e.Span, e.Others)
}

// Planner holds the reserved layouts of all trains.
type Planner struct {
	res map[string][]Reservation
}

// New returns an empty planner.
func New() *Planner { return &Planner{res: map[string][]Reservation{}} }

// Reservations returns a copy of the train's current layout.
func (p *Planner) Reservations(train string) []Reservation {
	return cloneRes(p.res[train])
}

// Trains returns the sorted IDs of all trains with a stored layout.
func (p *Planner) Trains() []string {
	out := make([]string, 0, len(p.res))
	for id := range p.res {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Add stores the initial layout of a train that does not exist yet.
func (p *Planner) Add(train string, layout []Reservation) error {
	if _, ok := p.res[train]; ok {
		return fmt.Errorf("railplan: train %q already exists", train)
	}
	return p.RescheduleWhole(train, layout)
}

// RescheduleWhole replaces the train's whole layout atomically. The
// train's own old reservations are excluded from the conflict check;
// on any failure the old layout is kept untouched.
func (p *Planner) RescheduleWhole(train string, next []Reservation) error {
	if err := validateLayout(next); err != nil {
		return fmt.Errorf("railplan: train %q: %w", train, err)
	}
	if err := p.checkFree(next, map[string]bool{train: true}); err != nil {
		return err
	}
	p.res[train] = cloneRes(next)
	return nil
}

// validateLayout checks domain bounds and self-overlap within one layout.
func validateLayout(layout []Reservation) error {
	for _, r := range layout {
		if !r.Span.Valid() {
			return fmt.Errorf("invalid interval %v on %s (domain [0,%d))", r.Span, r.Track, MaxTime)
		}
	}
	for i := 0; i < len(layout); i++ {
		for j := i + 1; j < len(layout); j++ {
			if layout[i].Track == layout[j].Track && layout[i].Span.Overlaps(layout[j].Span) {
				return fmt.Errorf("self-overlap on %s: %v vs %v", layout[i].Track, layout[i].Span, layout[j].Span)
			}
		}
	}
	return nil
}

// checkFree ensures every reservation in layout avoids all stored
// reservations except those of the excluded trains.
func (p *Planner) checkFree(layout []Reservation, exclude map[string]bool) error {
	for _, r := range layout {
		if others := p.conflicts(r, exclude); len(others) > 0 {
			return &ConflictError{Track: r.Track, Span: r.Span, Others: others}
		}
	}
	return nil
}

// conflicts returns the sorted IDs of non-excluded trains whose
// reservations overlap r on the same track.
func (p *Planner) conflicts(r Reservation, exclude map[string]bool) []string {
	seen := map[string]bool{}
	for id, rs := range p.res {
		if exclude[id] {
			continue
		}
		for _, o := range rs {
			if o.Track == r.Track && o.Span.Overlaps(r.Span) {
				seen[id] = true
				break
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func cloneRes(rs []Reservation) []Reservation {
	if rs == nil {
		return nil
	}
	out := make([]Reservation, len(rs))
	copy(out, rs)
	return out
}
