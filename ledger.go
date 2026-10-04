// Package ledger analyzes borrow, repay and reversal events to compute
// liabilities over time. Events are ordered by (Time, Seq). Outstanding
// liability carries across query interval boundaries. Amounts are integers;
// illegal over-repayments (and other invalid events) have no effect.
package ledger

import "sort"

// EventType identifies the kind of an Event.
type EventType int

const (
	// Borrow increases liability by Amount.
	Borrow EventType = iota
	// Repay decreases liability by Amount. A repayment that exceeds the
	// current outstanding liability is illegal and has no effect.
	Repay
	// Reverse cancels the effect of a previous, still-effective Borrow or
	// Repay event referenced by RefID.
	Reverse
)

// Event is a single ledger event.
type Event struct {
	ID     int64
	Time   int64
	Seq    int64
	Type   EventType
	Amount int64
	RefID  int64 // referenced event ID, only used by Reverse
}

// state is the mutable replay state shared by the analyzer and the
// reference replay implementation.
type state struct {
	liability int64
	active    map[int64]Event // effective, unreversed Borrow/Repay events by ID
}

func newState() *state {
	return &state{active: make(map[int64]Event)}
}

// apply applies one event to st. Invalid events leave st unchanged.
func apply(st *state, e Event) {
	switch e.Type {
	case Borrow:
		if e.Amount <= 0 {
			return
		}
		if _, dup := st.active[e.ID]; dup {
			return
		}
		st.active[e.ID] = e
		st.liability += e.Amount
	case Repay:
		if e.Amount <= 0 || e.Amount > st.liability {
			// Illegal over-repayment (or non-positive amount): no effect.
			return
		}
		if _, dup := st.active[e.ID]; dup {
			return
		}
		st.active[e.ID] = e
		st.liability -= e.Amount
	case Reverse:
		orig, ok := st.active[e.RefID]
		if !ok {
			// Unknown, already reversed, or never-effective target.
			return
		}
		switch orig.Type {
		case Borrow:
			if st.liability < orig.Amount {
				// Reversal would drive liability negative: no effect.
				return
			}
			st.liability -= orig.Amount
		case Repay:
			st.liability += orig.Amount
		}
		delete(st.active, e.RefID)
	}
}

// Analyzer answers max-liability queries over an appendable event set.
type Analyzer struct {
	events []Event
	dirty  bool

	times     []int64 // sorted event times
	liability []int64 // liability after the i-th event
	log       []int   // log[i] = floor(log2(i))
	table     [][]int // sparse table of best indices (max liability, earliest time)
}

// NewAnalyzer returns an empty Analyzer.
func NewAnalyzer() *Analyzer {
	return &Analyzer{dirty: true}
}

// AddEvent appends an event. Events may be added in any order; they are
// sorted by (Time, Seq) when the index is rebuilt.
func (a *Analyzer) AddEvent(e Event) {
	a.events = append(a.events, e)
	a.dirty = true
}

// better returns the index with higher liability, breaking ties toward the
// earlier time.
func (a *Analyzer) better(i, j int) int {
	if a.liability[i] != a.liability[j] {
		if a.liability[i] > a.liability[j] {
			return i
		}
		return j
	}
	if a.times[i] <= a.times[j] {
		return i
	}
	return j
}

func (a *Analyzer) rebuild() {
	evs := make([]Event, len(a.events))
	copy(evs, a.events)
	sort.SliceStable(evs, func(i, j int) bool {
		if evs[i].Time != evs[j].Time {
			return evs[i].Time < evs[j].Time
		}
		return evs[i].Seq < evs[j].Seq
	})

	n := len(evs)
	a.times = make([]int64, n)
	a.liability = make([]int64, n)
	st := newState()
	for i, e := range evs {
		apply(st, e)
		a.times[i] = e.Time
		a.liability[i] = st.liability
	}

	a.log = make([]int, n+1)
	for i := 2; i <= n; i++ {
		a.log[i] = a.log[i/2] + 1
	}
	levels := 0
	if n > 0 {
		levels = a.log[n] + 1
	}
	a.table = make([][]int, levels)
	if n > 0 {
		a.table[0] = make([]int, n)
		for i := range a.table[0] {
			a.table[0][i] = i
		}
		for l := 1; l < levels; l++ {
			size := n - (1 << l) + 1
			a.table[l] = make([]int, size)
			for i := 0; i < size; i++ {
				a.table[l][i] = a.better(a.table[l-1][i], a.table[l-1][i+(1<<(l-1))])
			}
		}
	}
	a.dirty = false
}

// rangeBest returns the best event index in [l, r).
func (a *Analyzer) rangeBest(l, r int) (int, bool) {
	if l >= r {
		return 0, false
	}
	k := a.log[r-l]
	return a.better(a.table[k][l], a.table[k][r-(1<<k)]), true
}

// MaxLiability returns the maximum outstanding liability over the interval
// [start, end] and the earliest time in the interval at which it occurs.
// Liability accrued before start carries into the interval: the value at
// start includes all events with Time <= start. Events are applied in
// (Time, Seq) order.
func (a *Analyzer) MaxLiability(start, end int64) (maxAmount int64, at int64) {
	if start > end {
		return 0, start
	}
	if a.dirty {
		a.rebuild()
	}
	// Events [0, j) have Time <= start; events [0, k) have Time <= end.
	j := sort.Search(len(a.times), func(i int) bool { return a.times[i] > start })
	k := sort.Search(len(a.times), func(i int) bool { return a.times[i] > end })

	at = start
	if j > 0 {
		maxAmount = a.liability[j-1]
	}
	if idx, ok := a.rangeBest(j, k); ok && a.liability[idx] > maxAmount {
		maxAmount = a.liability[idx]
		at = a.times[idx]
	}
	return maxAmount, at
}
