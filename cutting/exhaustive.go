package cutting

// Exhaustive finds the optimum by enumerating every assignment of pieces to
// bars (set partitions into at most MaxBars bins) with no cost pruning. It is
// only practical for small instances and serves as an independent cross-check
// of Solve.
func Exhaustive(spec *Spec) (costKey, bool, error) {
	s, err := newSolver(spec)
	if err != nil {
		return costKey{}, false, err
	}
	best := costKey{}
	found := false
	var rec func(idx int, bins []bin)
	rec = func(idx int, bins []bin) {
		if idx == len(s.pieces) {
			key, _, ok := s.assign(bins)
			if ok && (!found || key.less(best)) {
				best, found = key, true
			}
			return
		}
		p := s.pieces[idx]
		for i := range bins {
			k := len(bins[i].pieces)
			if k >= s.maxPieces {
				continue
			}
			newSum := bins[i].sum + p.length
			if newSum+s.kerf*k > s.maxStock {
				continue
			}
			bins[i].pieces = append(bins[i].pieces, idx)
			bins[i].sum = newSum
			rec(idx+1, bins)
			bins[i].pieces = bins[i].pieces[:k]
			bins[i].sum -= p.length
		}
		if len(bins) < s.maxBars {
			rec(idx+1, append(bins, bin{sum: p.length, pieces: []int{idx}}))
		}
	}
	rec(0, nil)
	return best, found, nil
}
