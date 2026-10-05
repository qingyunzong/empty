package resultstore

import "sort"

// Replay builds a reference store by applying the full-history rule model to
// runs in canonical order: ascending (Round, At), with original position as
// the final tie-breaker. Because same-round conflicts are rejected and exact
// duplicates are idempotent, any conflict-free set of runs converges to the
// same state regardless of import order; Replay is the canonical model that
// out-of-order imports are checked against.
func Replay(runs []Run) (*Store, error) {
	idx := make([]int, len(runs))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool {
		ra, rb := runs[idx[a]], runs[idx[b]]
		if ra.Round != rb.Round {
			return ra.Round < rb.Round
		}
		if !ra.At.Equal(rb.At) {
			return ra.At.Before(rb.At)
		}
		return idx[a] < idx[b]
	})
	s := new(Store)
	for _, i := range idx {
		if err := s.AddRun(runs[i]); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// ConsistentWithModel reports whether the store's derived state matches the
// full-history rule model replayed in canonical order from the store's own
// complete history. It compares the accepted run set, the latest outcome per
// case, and the per-source summary.
func (s *Store) ConsistentWithModel() bool {
	model, err := Replay(s.runs)
	if err != nil {
		return false
	}
	if model.RunCount() != s.RunCount() {
		return false
	}
	// Same accepted (case, round) -> outcome set.
	for key, want := range model.byKey {
		if got, ok := s.byKey[key]; !ok || got != want {
			return false
		}
	}
	// Same latest outcome per case.
	for id, want := range model.latest {
		got, ok := s.latest[id]
		if !ok || got != want {
			return false
		}
	}
	// Same per-source summary.
	a, b := s.SourceSummary(), model.SourceSummary()
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Source != b[i].Source || a[i].Total != b[i].Total ||
			a[i].Pass != b[i].Pass || a[i].Fail != b[i].Fail ||
			a[i].Skip != b[i].Skip || len(a[i].Rounds) != len(b[i].Rounds) {
			return false
		}
		for j := range a[i].Rounds {
			if a[i].Rounds[j] != b[i].Rounds[j] {
				return false
			}
		}
	}
	return true
}
