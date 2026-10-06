// Package occupancy implements a track-occupancy planner: trains reserve
// half-open time intervals on numbered tracks, and reservations conflict
// only when they overlap on the same track.
package occupancy

import (
	"errors"
	"fmt"
)

// MaxTime is the exclusive upper bound of the time domain [0, MaxTime).
const MaxTime = 1000

// Reservation reserves one track for the half-open interval [Start, End).
type Reservation struct {
	Track int
	Start int
	End   int
}

// Overlaps reports whether two reservations conflict: same track and
// overlapping half-open intervals. Touching endpoints do not conflict.
func (r Reservation) Overlaps(o Reservation) bool {
	return r.Track == o.Track && r.Start < o.End && o.Start < r.End
}

func validateReservations(res []Reservation) error {
	for _, r := range res {
		if r.Track < 0 {
			return fmt.Errorf("negative track %d", r.Track)
		}
		if r.Start < 0 || r.End > MaxTime || r.Start >= r.End {
			return fmt.Errorf("interval [%d,%d) empty or outside time domain [0,%d)", r.Start, r.End, MaxTime)
		}
	}
	for i := range res {
		for j := i + 1; j < len(res); j++ {
			if res[i].Overlaps(res[j]) {
				return fmt.Errorf("same-train reservations [%d,%d) and [%d,%d) overlap on track %d",
					res[i].Start, res[i].End, res[j].Start, res[j].End, res[i].Track)
			}
		}
	}
	return nil
}

// Planner holds the reservations of every train.
type Planner struct {
	trains map[string][]Reservation
}

// New returns an empty planner.
func New() *Planner {
	return &Planner{trains: map[string][]Reservation{}}
}

func clone(res []Reservation) []Reservation {
	out := make([]Reservation, len(res))
	copy(out, res)
	return out
}

// Reservations returns a copy of the train's current reservations.
func (p *Planner) Reservations(id string) []Reservation {
	return clone(p.trains[id])
}

// Has reports whether the train exists.
func (p *Planner) Has(id string) bool {
	_, ok := p.trains[id]
	return ok
}

// AddTrain registers a train with its initial reservations.
func (p *Planner) AddTrain(id string, res []Reservation) error {
	if _, ok := p.trains[id]; ok {
		return fmt.Errorf("train %q already exists", id)
	}
	if err := validateReservations(res); err != nil {
		return err
	}
	if p.conflictsWithOthers(id, res) {
		return errors.New("reservations conflict with another train")
	}
	p.trains[id] = clone(res)
	return nil
}

// conflictsWithOthers checks res against every train except self.
func (p *Planner) conflictsWithOthers(self string, res []Reservation) bool {
	for id, other := range p.trains {
		if id == self {
			continue
		}
		for _, a := range res {
			for _, b := range other {
				if a.Overlaps(b) {
					return true
				}
			}
		}
	}
	return false
}

// Reschedule replaces all of a train's reservations as a whole. The train's
// own old reservations are excluded from the conflict check, and on any
// failure the old plan is kept untouched.
func (p *Planner) Reschedule(id string, newRes []Reservation) bool {
	if _, ok := p.trains[id]; !ok {
		return false
	}
	if err := validateReservations(newRes); err != nil {
		return false
	}
	if p.conflictsWithOthers(id, newRes) {
		return false
	}
	p.trains[id] = clone(newRes)
	return true
}

// Shifted returns all reservations shifted by delta in time.
func Shifted(res []Reservation, delta int) []Reservation {
	out := make([]Reservation, len(res))
	for i, r := range res {
		out[i] = Reservation{Track: r.Track, Start: r.Start + delta, End: r.End + delta}
	}
	return out
}

// Shift reschedules a train by shifting all of its reservations by delta.
// On failure the old plan is kept.
func (p *Planner) Shift(id string, delta int) bool {
	res, ok := p.trains[id]
	if !ok {
		return false
	}
	return p.Reschedule(id, Shifted(res, delta))
}
