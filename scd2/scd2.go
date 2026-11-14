package scd2

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Interval is a half-open validity range [From, To) for one business key.
// A zero To marks the open-ended, current interval.
type Interval[A any] struct {
	Key   string
	From  time.Time
	To    time.Time
	Attrs A
}

// IsCurrent reports whether the interval is the open-ended current row.
func (iv Interval[A]) IsCurrent() bool { return iv.To.IsZero() }

// Contains reports whether t falls inside [From, To).
func (iv Interval[A]) Contains(t time.Time) bool {
	if t.Before(iv.From) {
		return false
	}
	return iv.To.IsZero() || t.Before(iv.To)
}

func (iv Interval[A]) String() string {
	to := "open"
	if !iv.To.IsZero() {
		to = iv.To.Format(time.RFC3339)
	}
	return fmt.Sprintf("%s[%s, %s)=%v", iv.Key, iv.From.Format(time.RFC3339), to, iv.Attrs)
}

// EventKind distinguishes source mutations.
type EventKind int

const (
	// EventUpsert inserts a row or changes its attributes as of At.
	EventUpsert EventKind = iota
	// EventDelete removes the row as of At.
	EventDelete
)

// Event is one source mutation stamped with its business key and source
// effective time. Events may arrive in any order.
type Event[A any] struct {
	Key   string
	At    time.Time
	Kind  EventKind
	Attrs A // only for EventUpsert
}

// Upsert builds an insert/change event.
func Upsert[A any](key string, at time.Time, attrs A) Event[A] {
	return Event[A]{Key: key, At: at, Kind: EventUpsert, Attrs: attrs}
}

// Delete builds a delete event.
func Delete[A any](key string, at time.Time) Event[A] {
	return Event[A]{Key: key, At: at, Kind: EventDelete}
}

// Store keeps SCD2 intervals grouped by business key. It is safe for
// concurrent use.
type Store[A any] struct {
	mu   sync.RWMutex
	eq   func(a, b A) bool
	rows map[string][]Interval[A] // sorted by From, non-overlapping, merged
	pts  map[string][]time.Time   // sorted distinct source event times per key
}

// New returns a Store for comparable attribute types, using == for
// attribute equality.
func New[A comparable]() *Store[A] {
	return NewFunc(func(a, b A) bool { return a == b })
}

// NewFunc returns a Store with a custom attribute equality function, for
// attribute types that are not comparable (e.g. map-based attributes).
func NewFunc[A any](eq func(a, b A) bool) *Store[A] {
	return &Store[A]{eq: eq, rows: make(map[string][]Interval[A]), pts: make(map[string][]time.Time)}
}

// Apply applies one event and returns the minimal changeset transforming
// the previous interval list into the new one.
func (s *Store[A]) Apply(ev Event[A]) Changeset[A] {
	s.mu.Lock()
	defer s.mu.Unlock()

	old := s.rows[ev.Key]
	pts := insertPoint(s.pts[ev.Key], ev.At)
	end := successor(pts, ev.At) // zero when no later event is known

	var next []Interval[A]
	switch ev.Kind {
	case EventDelete:
		next = deleteAt(old, ev.At, end)
	default:
		next = upsertAt(old, ev.At, end, ev.Attrs)
	}
	next = normalize(s.eq, next)

	cs := diffIntervals(ev.Key, old, next, s.eq)
	if len(next) == 0 {
		delete(s.rows, ev.Key)
	} else {
		s.rows[ev.Key] = next
	}
	s.pts[ev.Key] = pts
	return cs
}

// ApplyAll applies events in arrival order and returns the concatenated
// changesets. The resulting state is independent of arrival order.
func (s *Store[A]) ApplyAll(evs []Event[A]) Changeset[A] {
	var out Changeset[A]
	for _, ev := range evs {
		out = append(out, s.Apply(ev)...)
	}
	return out
}

// UpsertAt applies an insert/change event for key at the given source time.
func (s *Store[A]) UpsertAt(key string, at time.Time, attrs A) Changeset[A] {
	return s.Apply(Upsert(key, at, attrs))
}

// DeleteAt applies a delete event for key at the given source time.
func (s *Store[A]) DeleteAt(key string, at time.Time) Changeset[A] {
	return s.Apply(Delete[A](key, at))
}

// AsOf returns the interval covering t for key, i.e. the point-in-time
// answer to "what did the dimension row look like at t".
func (s *Store[A]) AsOf(key string, t time.Time) (Interval[A], bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ivs := s.rows[key]
	i := sort.Search(len(ivs), func(i int) bool { return ivs[i].From.After(t) }) - 1
	if i < 0 || !ivs[i].Contains(t) {
		return Interval[A]{}, false
	}
	iv := ivs[i]
	iv.Key = key
	return iv, true
}

// Current returns the open-ended current interval for key.
func (s *Store[A]) Current(key string) (Interval[A], bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ivs := s.rows[key]
	if n := len(ivs); n > 0 && ivs[n-1].IsCurrent() {
		iv := ivs[n-1]
		iv.Key = key
		return iv, true
	}
	return Interval[A]{}, false
}

// Intervals returns a copy of the interval list for key.
func (s *Store[A]) Intervals(key string) []Interval[A] {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ivs := s.rows[key]
	out := make([]Interval[A], len(ivs))
	for i, iv := range ivs {
		iv.Key = key
		out[i] = iv
	}
	return out
}

// Validate checks the structural invariants of every key: half-open,
// non-overlapping, chronologically ordered intervals with no zero-length
// ranges and at most one (trailing) current interval.
func (s *Store[A]) Validate() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for key, ivs := range s.rows {
		for i, iv := range ivs {
			if !iv.To.IsZero() && !iv.From.Before(iv.To) {
				return fmt.Errorf("scd2: %s: interval %d %s is empty or inverted", key, i, iv)
			}
			if i == 0 {
				continue
			}
			prev := ivs[i-1]
			if prev.To.IsZero() {
				return fmt.Errorf("scd2: %s: current interval %d is not last", key, i-1)
			}
			if prev.To.After(iv.From) {
				return fmt.Errorf("scd2: %s: intervals %d and %d overlap", key, i-1, i)
			}
		}
	}
	return nil
}

// upsertAt returns the interval list with attrs effective over
// [at, end), where end is the next known source event time (zero for
// open-ended). The interval covering at is split; an interval starting
// exactly at at is replaced. Because merged intervals may span recorded
// event times, the tail beyond end keeps its previous attributes.
func upsertAt[A any](ivs []Interval[A], at, end time.Time, attrs A) []Interval[A] {
	tail := func(iv Interval[A]) []Interval[A] {
		if !end.IsZero() && (iv.To.IsZero() || end.Before(iv.To)) {
			return []Interval[A]{{From: end, To: iv.To, Attrs: iv.Attrs}}
		}
		return nil
	}
	out := make([]Interval[A], 0, len(ivs)+1)
	placed := false
	for _, iv := range ivs {
		switch {
		case !iv.To.IsZero() && !iv.To.After(at):
			// Entirely before at.
			out = append(out, iv)
		case iv.From.Before(at):
			// Covers at: truncate, the new segment follows.
			out = append(out, Interval[A]{From: iv.From, To: at, Attrs: iv.Attrs})
			out = append(out, Interval[A]{From: at, To: end, Attrs: attrs})
			out = append(out, tail(iv)...)
			placed = true
		default:
			// Starts at or after at.
			if !placed {
				placed = true
				if iv.From.Equal(at) {
					// Same-timestamp change: latest write wins.
					out = append(out, Interval[A]{From: at, To: end, Attrs: attrs})
					out = append(out, tail(iv)...)
					continue
				}
				out = append(out, Interval[A]{From: at, To: end, Attrs: attrs})
			}
			out = append(out, iv)
		}
	}
	if !placed {
		out = append(out, Interval[A]{From: at, To: end, Attrs: attrs})
	}
	return out
}

// insertPoint returns pts with t inserted, keeping sorted distinct order.
func insertPoint(pts []time.Time, t time.Time) []time.Time {
	i := sort.Search(len(pts), func(i int) bool { return !pts[i].Before(t) })
	if i < len(pts) && pts[i].Equal(t) {
		return pts
	}
	out := make([]time.Time, 0, len(pts)+1)
	out = append(out, pts[:i]...)
	out = append(out, t)
	out = append(out, pts[i:]...)
	return out
}

// successor returns the smallest recorded event time after t, or the zero
// time when t is the latest known event.
func successor(pts []time.Time, t time.Time) time.Time {
	i := sort.Search(len(pts), func(i int) bool { return pts[i].After(t) })
	if i < len(pts) {
		return pts[i]
	}
	return time.Time{}
}

// deleteAt removes the state over [at, end), where end is the next known
// source event time (zero for open-ended). The interval covering at is
// truncated; any tail beyond end keeps its previous attributes, and later
// intervals (re-insertions) are kept.
func deleteAt[A any](ivs []Interval[A], at, end time.Time) []Interval[A] {
	out := make([]Interval[A], 0, len(ivs))
	for _, iv := range ivs {
		switch {
		case iv.From.Equal(at):
			// Deleted exactly when it starts: keep only the tail.
			if !end.IsZero() && (iv.To.IsZero() || end.Before(iv.To)) {
				out = append(out, Interval[A]{From: end, To: iv.To, Attrs: iv.Attrs})
			}
		case iv.From.Before(at) && iv.Contains(at):
			out = append(out, Interval[A]{From: iv.From, To: at, Attrs: iv.Attrs})
			if !end.IsZero() && (iv.To.IsZero() || end.Before(iv.To)) {
				out = append(out, Interval[A]{From: end, To: iv.To, Attrs: iv.Attrs})
			}
		default:
			out = append(out, iv)
		}
	}
	return out
}

// normalize drops zero-length intervals and merges adjacent intervals with
// equal attributes.
func normalize[A any](eq func(a, b A) bool, ivs []Interval[A]) []Interval[A] {
	out := make([]Interval[A], 0, len(ivs))
	for _, iv := range ivs {
		if !iv.To.IsZero() && !iv.From.Before(iv.To) {
			continue
		}
		if n := len(out); n > 0 {
			last := &out[n-1]
			if last.To.Equal(iv.From) && eq(last.Attrs, iv.Attrs) {
				last.To = iv.To
				continue
			}
		}
		out = append(out, iv)
	}
	return out
}
