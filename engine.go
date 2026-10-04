// Package orderstats builds per-order state timelines from a stream of
// order events. Events are ordered by (time, version, ID); illegal
// transitions are recorded as rejection evidence and never take effect;
// corrections (a newer version of an existing event ID) may change the
// legality of later events, so affected orders are re-evaluated.
package orderstats

import (
	"sort"
	"time"
)

// Rejection is the evidence recorded for an event that did not take
// effect: the event itself, the state it was rejected from, and why.
type Rejection struct {
	Event  Event
	From   State
	Reason string
}

type ledger struct {
	events     []Event // corrections resolved, sorted by (time, version, ID)
	timeline   []Segment
	rejections []Rejection
}

// Engine incrementally ingests order events and maintains per-order
// state timelines.
type Engine struct {
	orders map[string]*ledger
}

// NewEngine returns an empty Engine.
func NewEngine() *Engine {
	return &Engine{orders: map[string]*ledger{}}
}

// Add ingests one event. An event whose ID is already known for the
// order is a correction: it replaces the stored event only when its
// Version is greater; otherwise it is stale and Add returns false.
// Because a correction may change the legality of later events, the
// order's timeline and rejection evidence are re-evaluated.
func (e *Engine) Add(ev Event) bool {
	l := e.orders[ev.Order]
	if l == nil {
		l = &ledger{}
		e.orders[ev.Order] = l
	}
	return l.add(ev)
}

func (l *ledger) add(ev Event) bool {
	for i, existing := range l.events {
		if existing.ID == ev.ID {
			if ev.Version <= existing.Version {
				return false
			}
			l.events = append(l.events[:i], l.events[i+1:]...)
			break
		}
	}
	idx := sort.Search(len(l.events), func(i int) bool { return !lessEvent(l.events[i], ev) })
	l.events = append(l.events, Event{})
	copy(l.events[idx+1:], l.events[idx:])
	l.events[idx] = ev
	l.timeline, l.rejections = fold(l.events)
	return true
}

// Timeline returns the order's current state timeline.
func (e *Engine) Timeline(order string) []Segment {
	if l := e.orders[order]; l != nil {
		return append([]Segment(nil), l.timeline...)
	}
	return nil
}

// Rejections returns the rejection evidence for the order, in the order
// the rejected events occur in the stream.
func (e *Engine) Rejections(order string) []Rejection {
	if l := e.orders[order]; l != nil {
		return append([]Rejection(nil), l.rejections...)
	}
	return nil
}

// Residency reports per-state residence time of the order inside the
// half-open interval [from, to).
func (e *Engine) Residency(order string, from, to time.Time) map[State]time.Duration {
	return Residency(e.Timeline(order), from, to)
}

// fold replays resolved, ordered events from scratch, building the state
// timeline. Illegal transitions leave the state untouched and are
// recorded as rejection evidence.
func fold(events []Event) ([]Segment, []Rejection) {
	var (
		tl   []Segment
		rejs []Rejection
		cur  = StateNone
	)
	for _, ev := range events {
		if !CanTransition(cur, ev.To) {
			rejs = append(rejs, Rejection{Event: ev, From: cur, Reason: transitionError(cur, ev.To)})
			continue
		}
		if n := len(tl); n > 0 && tl[n-1].End.IsZero() {
			tl[n-1].End = ev.Time
		}
		tl = append(tl, Segment{State: ev.To, Start: ev.Time})
		cur = ev.To
	}
	return tl, rejs
}

// Replay resolves corrections in a raw event stream, orders the events,
// and folds them from scratch. It is the reference used to verify
// incremental ingestion: after any sequence of Add calls, the Engine's
// state for an order must equal Replay of the raw events for that order.
func Replay(events []Event) ([]Segment, []Rejection) {
	return fold(resolve(events))
}

// resolve keeps only the highest version of each event ID and orders
// the survivors by (time, version, ID).
func resolve(events []Event) []Event {
	byID := map[string]Event{}
	var ids []string
	for _, ev := range events {
		if prev, ok := byID[ev.ID]; ok {
			if ev.Version > prev.Version {
				byID[ev.ID] = ev
			}
			continue
		}
		byID[ev.ID] = ev
		ids = append(ids, ev.ID)
	}
	out := make([]Event, 0, len(ids))
	for _, id := range ids {
		out = append(out, byID[id])
	}
	sort.Slice(out, func(i, j int) bool { return lessEvent(out[i], out[j]) })
	return out
}
