package dataeng

// EquivalenceResult records both containment directions.
//
// AB checks A contained in B; BA checks B contained in A. If either direction
// is NotContained, Equivalence is decided false even if the other direction is
// still Undecided. If both are Contained, Equivalence is decided true.
type EquivalenceResult struct {
	AB      Result
	BA      Result
	Equal   bool
	Decided bool
}

// CheckEquivalence checks A contained in B and B contained in A, applying
// budget independently to each direction. When a direction is Undecided, its
// Result.Cursor can be resumed with the corresponding Problem (problem or
// problem.Reverse()).
func CheckEquivalence(problem Problem, budget int) (EquivalenceResult, error) {
	ab, err := Check(problem, budget)
	if err != nil {
		return EquivalenceResult{}, err
	}
	ba, err := Check(problem.Reverse(), budget)
	if err != nil {
		return EquivalenceResult{}, err
	}

	out := EquivalenceResult{AB: ab, BA: ba}
	switch {
	case ab.Status == NotContained || ba.Status == NotContained:
		out.Equal = false
		out.Decided = true
	case ab.Status == Contained && ba.Status == Contained:
		out.Equal = true
		out.Decided = true
	default:
		out.Equal = false
		out.Decided = false
	}
	return out, nil
}
