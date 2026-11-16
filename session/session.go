// Package session implements a deterministic session-window state store for
// stream aggregation layers.
//
// Each event is assigned to a candidate session window [ts, ts+gap). When the
// candidate overlaps one or more live windows, those windows are merged: only
// the smallest window id survives as the canonical id and every merged-away
// window is retracted from the update stream. The store emits a changelog of
// paired Retract/Add changes so downstream consumers always observe the
// current aggregate, and late events revise previously emitted results.
//
// Watermarks drive state reclamation: a window's state is reclaimed once the
// watermark passes window.End + allowedLateness, and the last Add emitted
// before reclamation is the window's final result. Events arriving after
// their candidate window has been reclaimed are dropped.
//
// Window ids come from a single monotonic counter and merge order is fully
// determined by the input, so feeding the same sequence of events and
// watermarks into a fresh store replays the identical change sequence.
package session

import "sort"

// ID identifies a window within a Store. IDs are assigned from a single
// monotonic counter, so replaying the same input sequence yields the same IDs.
type ID int64

// Window is a half-open session interval [Start, End). Timestamps are int64
// event-time values in any consistent unit chosen by the caller.
type Window struct {
	ID    ID
	Start int64
	End   int64
}

// ChangeKind distinguishes the two sides of an update.
type ChangeKind int

const (
	// Retract withdraws a previously emitted result.
	Retract ChangeKind = iota
	// Add publishes a new result.
	Add
)

// String returns a human-readable name for the change kind.
func (k ChangeKind) String() string {
	if k == Retract {
		return "retract"
	}
	return "add"
}

// Change is one entry of the update stream. Updates to an already emitted
// window are always delivered as a Retract of the previously emitted window
// and value followed by an Add of the revised ones.
type Change[K comparable, A any] struct {
	// Seq is a store-wide monotonically increasing sequence number.
	Seq    int64
	Kind   ChangeKind
	Key    K
	Window Window
	Value  A
}

// Aggregator folds event values into per-window accumulator state.
// Implementations must be deterministic for replay to be stable.
type Aggregator[V, A any] interface {
	// New returns the zero accumulator.
	New() A
	// Add folds one event value into acc.
	Add(acc A, value V) A
	// Merge combines the accumulators of two windows being merged.
	Merge(a, b A) A
}

// windowState is the mutable per-window record held by a Store.
type windowState[A any] struct {
	win Window
	acc A
	// emittedWin/emittedAcc describe the result currently published on the
	// update stream; they are what a future Retract must withdraw.
	emitted    bool
	emittedWin Window
	emittedAcc A
}

// keyState holds the live windows of one key, sorted by (Start, ID). Windows
// of a key never overlap, so the order is total.
type keyState[A any] struct {
	windows []windowState[A]
}

// Store is a session-window state store keyed by K. It is not safe for
// concurrent use; serialize access from a single operator instance.
type Store[K comparable, V, A any] struct {
	gap       int64
	lateness  int64
	agg       Aggregator[V, A]
	states    map[K]*keyState[A]
	watermark int64
	hasWM     bool
	nextID    ID
	seq       int64
	dropped   int64
}

// New returns an empty Store. gap is the session timeout: events separated by
// less than gap land in the same window. allowedLateness extends how long a
// window's state is retained after its end passes the watermark. New panics
// if gap <= 0, allowedLateness < 0, or agg is nil.
func New[K comparable, V, A any](gap, allowedLateness int64, agg Aggregator[V, A]) *Store[K, V, A] {
	if gap <= 0 {
		panic("session: gap must be positive")
	}
	if allowedLateness < 0 {
		panic("session: allowed lateness must not be negative")
	}
	if agg == nil {
		panic("session: aggregator must not be nil")
	}
	return &Store[K, V, A]{
		gap:      gap,
		lateness: allowedLateness,
		agg:      agg,
		states:   make(map[K]*keyState[A]),
		nextID:   1,
	}
}

// OnEvent assigns one event to its session window, merging windows as needed,
// and returns the resulting changelog. dropped is true when the event arrived
// after its candidate window had already been reclaimed; a dropped event
// produces no changes.
func (s *Store[K, V, A]) OnEvent(key K, ts int64, value V) (changes []Change[K, A], dropped bool) {
	ks := s.states[key]
	if ks == nil {
		ks = &keyState[A]{}
		s.states[key] = ks
	}
	cand := Window{Start: ts, End: ts + s.gap}

	// Live windows are disjoint and sorted, so the overlapping ones form a
	// contiguous run.
	first, last := -1, -1
	for i := range ks.windows {
		w := ks.windows[i].win
		if w.Start < cand.End && cand.Start < w.End {
			if first < 0 {
				first = i
			}
			last = i
		}
	}

	if first < 0 {
		// The event would open a new window. Drop it when the event itself
		// is older than the watermark minus the allowed lateness; otherwise
		// ancient sessions could be resurrected after reclamation. Events
		// that overlap a live window are always accepted: their window is
		// still open, so they are not too late for it.
		if s.hasWM && ts+s.lateness < s.watermark {
			s.dropped++
			return nil, true
		}
		ws := windowState[A]{
			win: Window{ID: s.nextID, Start: cand.Start, End: cand.End},
			acc: s.agg.Add(s.agg.New(), value),
		}
		s.nextID++
		changes = append(changes, s.emitAdd(key, &ws))
		ks.windows = insertWindow(ks.windows, ws)
		return changes, false
	}

	overlapping := ks.windows[first : last+1]

	// The canonical window is the one with the smallest id; every other
	// merged window is retracted and discarded.
	canonical := 0
	for i := range overlapping {
		if overlapping[i].win.ID < overlapping[canonical].win.ID {
			canonical = i
		}
	}

	// Fold accumulators in sorted window order, then add the new event, so
	// the result is deterministic even for non-commutative aggregators.
	acc := overlapping[0].acc
	for i := 1; i < len(overlapping); i++ {
		acc = s.agg.Merge(acc, overlapping[i].acc)
	}
	acc = s.agg.Add(acc, value)

	start, end := cand.Start, cand.End
	for _, ws := range overlapping {
		if ws.win.Start < start {
			start = ws.win.Start
		}
		if ws.win.End > end {
			end = ws.win.End
		}
	}

	// Retract merged-away windows first (in sorted order), then the canonical
	// window's previous result, keeping the canonical retract/add pair adjacent.
	for i := range overlapping {
		if i == canonical {
			continue
		}
		if ws := overlapping[i]; ws.emitted {
			changes = append(changes, s.retractChange(key, ws))
		}
	}

	cw := overlapping[canonical]
	cw.win = Window{ID: cw.win.ID, Start: start, End: end}
	cw.acc = acc
	if cw.emitted {
		changes = append(changes, s.retractChange(key, cw))
	}
	changes = append(changes, s.emitAdd(key, &cw))

	// The merged window covers the whole overlapping run, so it takes the
	// run's place in the sorted slice.
	out := make([]windowState[A], 0, len(ks.windows)-(len(overlapping)-1))
	out = append(out, ks.windows[:first]...)
	out = append(out, cw)
	out = append(out, ks.windows[last+1:]...)
	ks.windows = out
	return changes, false
}

// OnWatermark advances the event-time watermark and reclaims the state of
// every window whose End + allowedLateness has passed. Watermarks are
// monotonic: a regressive watermark is ignored for the clock but reclamation
// still runs against the current one. It returns the reclaimed windows in id
// order; reclamation itself emits no changes, the last Add stands as final.
func (s *Store[K, V, A]) OnWatermark(wm int64) []Window {
	if !s.hasWM || wm > s.watermark {
		s.watermark = wm
		s.hasWM = true
	}
	var reclaimed []Window
	for key, ks := range s.states {
		kept := ks.windows[:0]
		for _, ws := range ks.windows {
			if ws.win.End+s.lateness <= s.watermark {
				reclaimed = append(reclaimed, ws.win)
			} else {
				kept = append(kept, ws)
			}
		}
		ks.windows = kept
		if len(ks.windows) == 0 {
			delete(s.states, key)
		}
	}
	sort.Slice(reclaimed, func(i, j int) bool { return reclaimed[i].ID < reclaimed[j].ID })
	return reclaimed
}

// ActiveWindows returns a copy of the live windows of key, sorted by start.
func (s *Store[K, V, A]) ActiveWindows(key K) []Window {
	ks := s.states[key]
	if ks == nil {
		return nil
	}
	out := make([]Window, len(ks.windows))
	for i, ws := range ks.windows {
		out[i] = ws.win
	}
	return out
}

// ActiveWindowCount returns the total number of live windows across all keys.
func (s *Store[K, V, A]) ActiveWindowCount() int {
	n := 0
	for _, ks := range s.states {
		n += len(ks.windows)
	}
	return n
}

// Watermark reports the current watermark and whether one has been set.
func (s *Store[K, V, A]) Watermark() (int64, bool) {
	return s.watermark, s.hasWM
}

// DroppedEvents returns how many events were dropped as too late.
func (s *Store[K, V, A]) DroppedEvents() int64 {
	return s.dropped
}

// emitAdd records ws as published and returns its Add change.
func (s *Store[K, V, A]) emitAdd(key K, ws *windowState[A]) Change[K, A] {
	ws.emitted = true
	ws.emittedWin = ws.win
	ws.emittedAcc = ws.acc
	return s.change(key, Add, ws.win, ws.acc)
}

// retractChange returns the Retract withdrawing ws's published result.
func (s *Store[K, V, A]) retractChange(key K, ws windowState[A]) Change[K, A] {
	return s.change(key, Retract, ws.emittedWin, ws.emittedAcc)
}

func (s *Store[K, V, A]) change(key K, kind ChangeKind, win Window, acc A) Change[K, A] {
	s.seq++
	return Change[K, A]{Seq: s.seq, Kind: kind, Key: key, Window: win, Value: acc}
}

// insertWindow inserts w into the sorted slice. w does not overlap any
// existing window, so the slice stays a sorted set of disjoint intervals.
func insertWindow[A any](ws []windowState[A], w windowState[A]) []windowState[A] {
	i := sort.Search(len(ws), func(i int) bool {
		if ws[i].win.Start != w.win.Start {
			return ws[i].win.Start > w.win.Start
		}
		return ws[i].win.ID > w.win.ID
	})
	ws = append(ws, windowState[A]{})
	copy(ws[i+1:], ws[i:])
	ws[i] = w
	return ws
}
