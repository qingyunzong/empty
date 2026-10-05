// Package perm converts a stream of permission events (grants, revocations
// and temporary exceptions) into half-open intervals of effective actions.
//
// Semantics:
//   - Events at the same tick are applied in ascending Version order.
//   - Revocation takes precedence: at equal (tick, version) a Revoke is
//     applied after a Grant, and a deny exception overrides an allow
//     exception whenever their windows overlap.
//   - An event with Corrects set supersedes (replaces) the referenced
//     historical event; corrections may chain.
//   - Effective actions are represented as half-open intervals [Start, End)
//     with adjacent intervals merged when both the action and the full
//     authorization chain are equal.
package perm

import (
	"fmt"
	"math"
	"sort"
)

// Infinite bounds an interval that never ends (or the open lower bound).
const Infinite = math.MaxInt64

// Action is the effective decision for a tick.
type Action int

const (
	Deny Action = iota
	Allow
)

func (a Action) String() string {
	if a == Allow {
		return "allow"
	}
	return "deny"
}

// Kind classifies an Event.
type Kind int

const (
	Grant Kind = iota
	Revoke
	// Exception is a temporary override window [Tick, End) carrying Action.
	Exception
)

// Event is a single permission event.
type Event struct {
	ID       string
	Tick     int64 // effective tick (window start for Exception)
	Version  int64 // ordering within the same tick
	Kind     Kind
	Action   Action // Exception only: the override action
	End      int64  // Exception only: window end, exclusive
	Corrects string // supersedes the event with this ID
}

// Step is one link of an authorization chain.
type Step struct {
	EventID string // "" for the implicit default
	Reason  string // "default", "grant", "revoke", "exception"
	Action  Action
}

// Decision is the effective action at a tick plus its full chain.
type Decision struct {
	Action Action
	Chain  []Step
}

func (d Decision) equal(o Decision) bool {
	if d.Action != o.Action || len(d.Chain) != len(o.Chain) {
		return false
	}
	for i := range d.Chain {
		if d.Chain[i] != o.Chain[i] {
			return false
		}
	}
	return true
}

// Interval is a half-open [Start, End) span with a constant decision.
type Interval struct {
	Start    int64
	End      int64 // exclusive; Infinite means unbounded
	Decision Decision
}

func (iv Interval) String() string {
	end := fmt.Sprint(iv.End)
	if iv.End == Infinite {
		end = "+inf"
	}
	return fmt.Sprintf("[%d, %s) -> %s", iv.Start, end, iv.Decision.Action)
}

// Store holds the event history and the derived interval timeline.
type Store struct {
	events    []Event // active events (corrections applied), sorted
	intervals []Interval
}

// kindRank orders events at equal (tick, version): Revoke is applied
// after Grant so revocation takes precedence.
func kindRank(k Kind) int {
	if k == Revoke {
		return 1
	}
	return 0
}

func lessEvent(a, b Event) bool {
	if a.Tick != b.Tick {
		return a.Tick < b.Tick
	}
	if a.Version != b.Version {
		return a.Version < b.Version
	}
	return kindRank(a.Kind) < kindRank(b.Kind)
}

// resolve applies corrections: any event whose ID is named by another
// event's Corrects field is superseded and dropped.
func resolve(events []Event) []Event {
	superseded := make(map[string]bool)
	for _, e := range events {
		if e.Corrects != "" {
			superseded[e.Corrects] = true
		}
	}
	active := make([]Event, 0, len(events))
	for _, e := range events {
		if !superseded[e.ID] {
			active = append(active, e)
		}
	}
	sort.Slice(active, func(i, j int) bool { return lessEvent(active[i], active[j]) })
	return active
}

// NewStore builds a Store from raw events, applying corrections and
// deriving the merged interval timeline.
func NewStore(events []Event) *Store {
	active := resolve(events)
	s := &Store{events: active}
	s.intervals = s.buildIntervals()
	return s
}

// Events returns the active (post-correction) events in canonical order.
func (s *Store) Events() []Event { return s.events }

// Intervals returns the merged half-open interval timeline.
func (s *Store) Intervals() []Interval { return s.intervals }

// decide computes the full authorization chain at tick t.
// It is the per-tick state model: every other representation must agree
// with it at every tick.
func (s *Store) decide(t int64) Decision {
	d := Decision{
		Action: Deny,
		Chain:  []Step{{Reason: "default", Action: Deny}},
	}
	// Base state: last grant/revoke at or before t, in (tick, version) order.
	for _, e := range s.events {
		if e.Kind == Exception || e.Tick > t {
			continue
		}
		if e.Kind == Grant {
			d.Action = Allow
			d.Chain = append(d.Chain, Step{EventID: e.ID, Reason: "grant", Action: Allow})
		} else {
			d.Action = Deny
			d.Chain = append(d.Chain, Step{EventID: e.ID, Reason: "revoke", Action: Deny})
		}
	}
	// Temporary exceptions covering t. Deny exceptions are applied after
	// allow exceptions so revocation takes precedence.
	for _, want := range [2]Action{Allow, Deny} {
		var best *Event
		for i := range s.events {
			e := &s.events[i]
			if e.Kind != Exception || e.Action != want {
				continue
			}
			if e.Tick <= t && t < e.End {
				best = e // latest in (tick, version) order wins
			}
		}
		if best != nil {
			d.Action = want
			d.Chain = append(d.Chain, Step{EventID: best.ID, Reason: "exception", Action: want})
		}
	}
	return d
}

// Query returns the effective action and the full authorization chain at t.
func (s *Store) Query(t int64) Decision {
	i := sort.Search(len(s.intervals), func(i int) bool {
		return s.intervals[i].End > t
	})
	if i < len(s.intervals) && s.intervals[i].Start <= t {
		return s.intervals[i].Decision
	}
	return s.decide(t) // outside derived range: fall back to the state model
}

// buildIntervals sweeps the event cut points and merges adjacent spans
// whose decisions (action and full chain) are equal.
func (s *Store) buildIntervals() []Interval {
	cuts := map[int64]bool{}
	for _, e := range s.events {
		cuts[e.Tick] = true
		if e.Kind == Exception {
			cuts[e.End] = true
		}
	}
	points := make([]int64, 0, len(cuts))
	for c := range cuts {
		points = append(points, c)
	}
	sort.Slice(points, func(i, j int) bool { return points[i] < points[j] })

	var out []Interval
	appendSpan := func(start, end int64) {
		if start >= end {
			return
		}
		d := s.decide(start)
		if n := len(out); n > 0 && out[n-1].End == start && out[n-1].Decision.equal(d) {
			out[n-1].End = end // adjacent merge
			return
		}
		out = append(out, Interval{Start: start, End: end, Decision: d})
	}
	prev := int64(math.MinInt64)
	for _, c := range points {
		appendSpan(prev, c)
		prev = c
	}
	appendSpan(prev, Infinite)
	return out
}
