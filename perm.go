// Package perm converts a history of grant, revoke and temporary-exception
// events into effective half-open intervals per action, and answers
// point-in-time queries with the full authorization chain.
//
// Semantics:
//   - Events are ordered by (Tick, Version); at the same tick and version a
//     Revoke takes priority over a Grant ("revoke wins" tie-break).
//   - A Grant/Revoke sets the base state from its tick onward.
//   - An Exception temporarily overrides the base state on [Tick, Until);
//     a Deny exception takes priority over an Allow exception.
//   - Intervals are half-open [Start, End); the final segment is open-ended
//     (End == Inf). Adjacent segments with the same decision and the same
//     authorization chain are merged.
package perm

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// Inf marks an open-ended interval end.
const Inf = int64(math.MaxInt64)

// Kind is the event kind.
type Kind int

const (
	Grant Kind = iota
	Revoke
	Exception
)

// Effect is the effect of a temporary exception.
type Effect int

const (
	Allow Effect = iota
	Deny
)

// Event is a single recorded permission event.
type Event struct {
	ID      int64
	Tick    int64
	Version int64
	Action  string
	Kind    Kind
	Effect  Effect // Exception only
	Until   int64  // Exception only: window is [Tick, Until)
}

func (e Event) String() string {
	switch e.Kind {
	case Grant:
		return fmt.Sprintf("grant#%d@%d:v%d", e.ID, e.Tick, e.Version)
	case Revoke:
		return fmt.Sprintf("revoke#%d@%d:v%d", e.ID, e.Tick, e.Version)
	default:
		eff := "allow"
		if e.Effect == Deny {
			eff = "deny"
		}
		return fmt.Sprintf("exception#%d[%d,%d):v%d:%s", e.ID, e.Tick, e.Until, e.Version, eff)
	}
}

// kindOrder breaks ties between events sharing (Tick, Version): Revoke is
// applied last so that it wins over a Grant.
func kindOrder(k Kind) int {
	switch k {
	case Grant:
		return 0
	case Exception:
		return 1
	case Revoke:
		return 2
	}
	return 3
}

func lessEvent(a, b Event) bool {
	if a.Tick != b.Tick {
		return a.Tick < b.Tick
	}
	if a.Version != b.Version {
		return a.Version < b.Version
	}
	if ka, kb := kindOrder(a.Kind), kindOrder(b.Kind); ka != kb {
		return ka < kb
	}
	return a.ID < b.ID
}

// Decision is the outcome at a point in time plus the authorization chain
// that produced it. The chain lists only determining events, in event order:
// the base Grant/Revoke that last changed the base state (redundant
// re-grants/re-revokes are skipped), plus the covering exceptions that
// actually flip the outcome (a deny exception is determining while the base
// is allowed or an allow exception is active; an allow exception is
// determining while the base is denied and no deny exception covers).
type Decision struct {
	Allowed bool
	Chain   []Event
}

// Segment is a maximal half-open interval [Start, End) with a constant
// decision and authorization chain.
type Segment struct {
	Start, End int64
	Decision   Decision
}

// Interval is an effective (allowed) half-open interval with its chain.
type Interval struct {
	Start, End int64
	Chain      []Event
}

// Ledger stores the event history and derives interval models from it.
type Ledger struct {
	events map[int64]Event
	nextID int64
}

func NewLedger() *Ledger {
	return &Ledger{events: make(map[int64]Event)}
}

// Append records an event and returns its assigned ID.
func (l *Ledger) Append(e Event) int64 {
	l.nextID++
	e.ID = l.nextID
	l.events[e.ID] = e
	return e.ID
}

// ErrUnknownEvent is returned by Correct for an unknown event ID.
var ErrUnknownEvent = errors.New("perm: unknown event ID")

// Correct replaces the recorded fields of a historical event, keeping its
// ID. Callers should bump Version to reflect the correction order.
func (l *Ledger) Correct(id int64, e Event) error {
	if _, ok := l.events[id]; !ok {
		return ErrUnknownEvent
	}
	e.ID = id
	l.events[id] = e
	return nil
}

// Events returns the recorded events for action in canonical order.
func (l *Ledger) Events(action string) []Event {
	var evts []Event
	for _, e := range l.events {
		if e.Action != action {
			continue
		}
		if e.Kind == Exception && e.Until <= e.Tick {
			continue // empty exception window
		}
		evts = append(evts, e)
	}
	sort.Slice(evts, func(i, j int) bool { return lessEvent(evts[i], evts[j]) })
	return evts
}

// decisionAt computes the decision at tick t from canonically ordered events.
func decisionAt(evts []Event, t int64) Decision {
	baseAllowed := false
	var base *Event
	for i := range evts {
		e := evts[i]
		if e.Kind == Exception || e.Tick > t {
			continue
		}
		if want := e.Kind == Grant; want != baseAllowed {
			baseAllowed = want
			base = &evts[i] // only state-changing events determine the chain
		}
	}
	var deny, allow []Event
	for _, e := range evts {
		if e.Kind != Exception || e.Tick > t || t >= e.Until {
			continue
		}
		if e.Effect == Deny {
			deny = append(deny, e)
		} else {
			allow = append(allow, e)
		}
	}
	var d Decision
	if base != nil {
		d.Chain = append(d.Chain, *base)
	}
	switch {
	case len(deny) > 0:
		d.Allowed = false
		if baseAllowed || len(allow) > 0 {
			d.Chain = append(d.Chain, deny...)
		}
	case len(allow) > 0:
		d.Allowed = true
		if !baseAllowed {
			d.Chain = append(d.Chain, allow...)
		}
	default:
		d.Allowed = baseAllowed
	}
	return d
}

func chainKey(d Decision) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%v|", d.Allowed)
	for _, e := range d.Chain {
		fmt.Fprintf(&b, "%d;", e.ID)
	}
	return b.String()
}

// Segments builds the full half-open segment model for action, from the
// first event tick to infinity. Adjacent segments with equal decision and
// chain are merged.
func (l *Ledger) Segments(action string) []Segment {
	evts := l.Events(action)
	if len(evts) == 0 {
		return nil
	}
	boundSet := map[int64]bool{}
	for _, e := range evts {
		boundSet[e.Tick] = true
		if e.Kind == Exception {
			boundSet[e.Until] = true
		}
	}
	bounds := make([]int64, 0, len(boundSet))
	for b := range boundSet {
		bounds = append(bounds, b)
	}
	sort.Slice(bounds, func(i, j int) bool { return bounds[i] < bounds[j] })

	var segs []Segment
	for i, b := range bounds {
		end := Inf
		if i+1 < len(bounds) {
			end = bounds[i+1]
		}
		dec := decisionAt(evts, b)
		if n := len(segs); n > 0 && chainKey(segs[n-1].Decision) == chainKey(dec) {
			segs[n-1].End = end // merge adjacent equal segments
			continue
		}
		segs = append(segs, Segment{Start: b, End: end, Decision: dec})
	}
	return segs
}

// Intervals returns only the effective (allowed) half-open intervals.
func (l *Ledger) Intervals(action string) []Interval {
	var out []Interval
	for _, s := range l.Segments(action) {
		if s.Decision.Allowed {
			out = append(out, Interval{Start: s.Start, End: s.End, Chain: s.Decision.Chain})
		}
	}
	return out
}

// Query returns the decision and the complete authorization chain for
// action at tick.
func (l *Ledger) Query(action string, tick int64) Decision {
	return decisionAt(l.Events(action), tick)
}
