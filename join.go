// Package intervaljoin implements a streaming interval join over two
// event streams. Events from the left and right streams are matched by key
// when their timestamps differ by at most d (inclusive). Matching is
// one-to-many: a single event may join with any number of events from the
// opposite stream.
//
// Unmatched (outer) rows are emitted only once the opposite stream's
// watermark has passed the latest timestamp at which a matching event could
// still arrive, i.e. watermark > event.ts + d. If a late event arrives after
// an unmatched row was emitted, the joiner emits a retraction for the stale
// unmatched row followed by inserts for the new matched rows.
//
// State is retained for arbitrary lateness so corrections always produce the
// same final result as a batch full interval join; production use would add
// a state TTL once lateness is bounded.
package intervaljoin

import "sort"

// Side identifies one of the two joined streams.
type Side int

const (
	Left Side = iota
	Right
)

// Event is a single record in either stream.
type Event struct {
	Key string
	Ts  int64
	Val any
}

// Row is one output row of the join. Exactly one of Left/Right is nil for
// unmatched (outer) rows; both are set for matched pairs.
type Row struct {
	Key   string
	Left  *Event
	Right *Event
}

// MsgKind distinguishes inserts from retractions.
type MsgKind int

const (
	Insert MsgKind = iota
	Retract
)

// Msg is a changelog message: an Insert adds a row to the result, a
// Retract removes a previously emitted row.
type Msg struct {
	Kind MsgKind
	Row  Row
}

type state struct {
	ev        Event
	matched   bool // at least one match found
	unmatched bool // unmatched row was emitted and may need retraction
}

// Joiner holds the join state for both streams.
type Joiner struct {
	d     int64
	left  map[string][]*state
	right map[string][]*state
	wl    int64 // left stream watermark
	wr    int64 // right stream watermark
}

// New returns a Joiner matching events whose timestamps differ by at most d.
func New(d int64) *Joiner {
	return &Joiner{
		d:     d,
		left:  map[string][]*state{},
		right: map[string][]*state{},
		wl:    minInt64,
		wr:    minInt64,
	}
}

const minInt64 = -1 << 63

func ptr(e Event) *Event { return &e }

func absDiff(a, b int64) int64 {
	if a >= b {
		return a - b
	}
	return b - a
}

// AddLeft ingests one left-stream event and returns the resulting changelog.
func (j *Joiner) AddLeft(e Event) []Msg {
	st := &state{ev: e}
	j.left[e.Key] = append(j.left[e.Key], st)
	var out []Msg
	for _, r := range j.right[e.Key] {
		if absDiff(e.Ts, r.ev.Ts) <= j.d {
			st.matched = true
			r.matched = true
			if r.unmatched {
				r.unmatched = false
				out = append(out, Msg{Retract, Row{Key: e.Key, Right: ptr(r.ev)}})
			}
			out = append(out, Msg{Insert, Row{Key: e.Key, Left: ptr(e), Right: ptr(r.ev)}})
		}
	}
	if !st.matched && j.wr > e.Ts+j.d {
		st.unmatched = true
		out = append(out, Msg{Insert, Row{Key: e.Key, Left: ptr(e)}})
	}
	return out
}

// AddRight ingests one right-stream event and returns the resulting changelog.
func (j *Joiner) AddRight(e Event) []Msg {
	st := &state{ev: e}
	j.right[e.Key] = append(j.right[e.Key], st)
	var out []Msg
	for _, l := range j.left[e.Key] {
		if absDiff(e.Ts, l.ev.Ts) <= j.d {
			st.matched = true
			l.matched = true
			if l.unmatched {
				l.unmatched = false
				out = append(out, Msg{Retract, Row{Key: e.Key, Left: ptr(l.ev)}})
			}
			out = append(out, Msg{Insert, Row{Key: e.Key, Left: ptr(l.ev), Right: ptr(e)}})
		}
	}
	if !st.matched && j.wl > e.Ts+j.d {
		st.unmatched = true
		out = append(out, Msg{Insert, Row{Key: e.Key, Right: ptr(e)}})
	}
	return out
}

// AdvanceLeft moves the left-stream watermark and flushes any right-side
// rows that can no longer be matched.
func (j *Joiner) AdvanceLeft(wm int64) []Msg {
	if wm > j.wl {
		j.wl = wm
	}
	return j.flush(j.right, j.wl, Right)
}

// AdvanceRight moves the right-stream watermark and flushes any left-side
// rows that can no longer be matched.
func (j *Joiner) AdvanceRight(wm int64) []Msg {
	if wm > j.wr {
		j.wr = wm
	}
	return j.flush(j.left, j.wr, Left)
}

// flush emits unmatched rows for buffered events of one side whose latest
// possible match time (ts + d) is strictly behind the opposite watermark.
func (j *Joiner) flush(buf map[string][]*state, wm int64, side Side) []Msg {
	var out []Msg
	for _, states := range buf {
		for _, st := range states {
			if !st.matched && !st.unmatched && wm > st.ev.Ts+j.d {
				st.unmatched = true
				row := Row{Key: st.ev.Key}
				if side == Left {
					row.Left = ptr(st.ev)
				} else {
					row.Right = ptr(st.ev)
				}
				out = append(out, Msg{Insert, row})
			}
		}
	}
	sort.Slice(out, func(a, b int) bool {
		ea, eb := out[a].Row.Left, out[b].Row.Left
		if side == Right {
			ea, eb = out[a].Row.Right, out[b].Row.Right
		}
		if out[a].Row.Key != out[b].Row.Key {
			return out[a].Row.Key < out[b].Row.Key
		}
		return ea.Ts < eb.Ts
	})
	return out
}
