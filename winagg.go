// Package winagg aggregates events into half-open windows by business
// (event) time, with a monotonically non-decreasing watermark, bounded
// lateness, and ID-based corrections that revoke the old contribution.
package winagg

import "sort"

// Kind describes how an event affects existing state.
type Kind int

const (
	// Add contributes a new event.
	Add Kind = iota
	// Correction references the original event ID: the old contribution
	// of that ID is revoked and the new one applied instead.
	Correction
)

// Event is a single record arriving at the aggregator.
type Event struct {
	ID    string
	Kind  Kind
	Time  int64 // business time
	Value float64
}

// Result is the outcome of ingesting one event.
type Result int

const (
	// Applied means a new contribution was added.
	Applied Result = iota
	// Corrected means an existing contribution was revoked and replaced.
	Corrected
	// RejectedLate means the event is older than watermark-lateness.
	RejectedLate
)

func (r Result) String() string {
	switch r {
	case Applied:
		return "applied"
	case Corrected:
		return "corrected"
	case RejectedLate:
		return "rejected-late"
	}
	return "unknown"
}

// WindowStat is an immutable snapshot of one half-open window [Start, End).
type WindowStat struct {
	Start    int64
	End      int64 // exclusive
	Sum      float64
	Count    int
	Revision uint64 // incremented on every mutation of this window
}

type contribution struct {
	windowStart int64
	value       float64
}

type window struct {
	sum      float64
	count    int
	revision uint64
}

// Aggregator keeps per-window aggregates plus the live contribution of
// every event ID so corrections can revoke them.
type Aggregator struct {
	windowSize int64
	lateness   int64

	watermark int64
	started   bool

	windows  map[int64]*window
	contribs map[string]contribution
	rejected int
}

// NewAggregator creates an Aggregator. windowSize is the window length in
// business-time units; lateness L allows events as old as watermark-L.
func NewAggregator(windowSize, lateness int64) *Aggregator {
	if windowSize <= 0 {
		panic("winagg: windowSize must be positive")
	}
	if lateness < 0 {
		panic("winagg: lateness must be non-negative")
	}
	return &Aggregator{
		windowSize: windowSize,
		lateness:   lateness,
		windows:    make(map[int64]*window),
		contribs:   make(map[string]contribution),
	}
}

// windowStart maps a business time to the start of its half-open window
// [start, start+windowSize), correct for negative times as well.
func (a *Aggregator) windowStart(t int64) int64 {
	r := t % a.windowSize
	if r < 0 {
		r += a.windowSize
	}
	return t - r
}

// Ingest feeds one event. Events older than watermark-lateness are
// rejected; otherwise the watermark advances (never retreats), any prior
// contribution of the same ID is revoked, and the new one applied.
func (a *Aggregator) Ingest(e Event) Result {
	if a.started && e.Time < a.watermark-a.lateness {
		a.rejected++
		return RejectedLate
	}
	if !a.started || e.Time > a.watermark {
		a.watermark = e.Time
	}
	a.started = true

	res := Applied
	if old, ok := a.contribs[e.ID]; ok {
		w := a.windows[old.windowStart]
		w.sum -= old.value
		w.count--
		w.revision++
		res = Corrected
	}

	ws := a.windowStart(e.Time)
	w := a.windows[ws]
	if w == nil {
		w = &window{}
		a.windows[ws] = w
	}
	w.sum += e.Value
	w.count++
	w.revision++
	a.contribs[e.ID] = contribution{windowStart: ws, value: e.Value}
	return res
}

// Watermark returns the current watermark and whether any event has been
// accepted. The watermark never decreases.
func (a *Aggregator) Watermark() (int64, bool) {
	return a.watermark, a.started
}

// Rejected returns the number of events rejected as too late.
func (a *Aggregator) Rejected() int {
	return a.rejected
}

// Snapshot returns the current statistics of all touched windows, sorted
// by window start. Windows whose count dropped to zero are retained with
// their revision history.
func (a *Aggregator) Snapshot() []WindowStat {
	out := make([]WindowStat, 0, len(a.windows))
	for start, w := range a.windows {
		out = append(out, WindowStat{
			Start:    start,
			End:      start + a.windowSize,
			Sum:      w.sum,
			Count:    w.count,
			Revision: w.revision,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}
