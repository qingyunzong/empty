package ledger

import "sort"

// ReplayMaxLiability is the reference implementation: it sorts the events by
// (Time, Seq) and performs a complete replay from scratch, returning the
// maximum liability over [start, end] and the earliest time it occurs. It
// is used to cross-check Analyzer results (full-replay verification).
func ReplayMaxLiability(events []Event, start, end int64) (maxAmount int64, at int64) {
	if start > end {
		return 0, start
	}
	evs := make([]Event, len(events))
	copy(evs, events)
	sort.SliceStable(evs, func(i, j int) bool {
		if evs[i].Time != evs[j].Time {
			return evs[i].Time < evs[j].Time
		}
		return evs[i].Seq < evs[j].Seq
	})

	st := newState()
	at = start
	for _, e := range evs {
		if e.Time > end {
			break
		}
		apply(st, e)
		if e.Time <= start {
			// Liability carried into the interval boundary.
			maxAmount = st.liability
		} else if st.liability > maxAmount {
			maxAmount = st.liability
			at = e.Time
		}
	}
	return maxAmount, at
}
