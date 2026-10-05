package matrix

import (
	"fmt"
	"math/big"
	"sort"
)

// exactBudget caps the number of nodes the exact minimum search may visit
// before falling back to the greedy result.
const exactBudget = 3_000_000

// solveOutput holds the solver result before certificate assembly.
type solveOutput struct {
	model     *model
	legal     [][]int    // all legal configurations
	masks     []*big.Int // pair mask per legal configuration
	coverable *big.Int   // union of all pair masks
	chosen    []int      // indices into legal
	exact     bool       // true if minimality was proven exactly
}

// ErrLimit is returned when the cover cannot be built within the config limit.
type ErrLimit struct {
	Needed int // configs required by the greedy solution (lower bound on optimum)
	Limit  int
}

func (e *ErrLimit) Error() string {
	return fmt.Sprintf("cannot cover all legal pairs within %d configurations (greedy needs %d)", e.Limit, e.Needed)
}

// solve finds a small set of legal configurations covering every coverable pair.
func solve(spec *Spec, maxConfigs int) (*solveOutput, error) {
	m, err := buildModel(spec)
	if err != nil {
		return nil, err
	}
	legal, err := m.enumerateLegal()
	if err != nil {
		return nil, err
	}
	out := &solveOutput{model: m, legal: legal, coverable: new(big.Int)}
	for _, cfg := range legal {
		mask := m.pairMask(cfg)
		out.masks = append(out.masks, mask)
		out.coverable.Or(out.coverable, mask)
	}
	if popcount(out.coverable) == 0 {
		out.exact = true
		return out, nil
	}
	chosen := greedy(out.masks, out.coverable)
	if len(chosen) > maxConfigs {
		return nil, &ErrLimit{Needed: len(chosen), Limit: maxConfigs}
	}
	out.chosen = chosen
	if len(chosen) <= 1 {
		// A non-empty coverable set cannot be covered by zero configs.
		out.exact = true
		return out, nil
	}
	// Try to prove minimality exactly: search for a cover smaller than greedy.
	idx, found, completed := exactMin(out.masks, out.coverable, len(chosen)-1)
	if found {
		out.chosen = idx
		out.exact = true
	} else if completed {
		// Search finished without finding a smaller cover: greedy is optimal.
		out.exact = true
	}
	return out, nil
}

// greedy picks configurations covering the most still-uncovered pairs.
func greedy(masks []*big.Int, full *big.Int) []int {
	uncovered := new(big.Int).Set(full)
	var chosen []int
	used := make([]bool, len(masks))
	tmp := new(big.Int)
	for popcount(uncovered) > 0 {
		best, bestGain := -1, 0
		for i, mask := range masks {
			if used[i] {
				continue
			}
			gain := popcount(tmp.And(mask, uncovered))
			if gain > bestGain {
				best, bestGain = i, gain
			}
		}
		if best < 0 {
			break
		}
		used[best] = true
		chosen = append(chosen, best)
		uncovered.AndNot(uncovered, masks[best])
	}
	return chosen
}

// exactMin searches for a cover of full using at most maxK configurations.
// completed reports whether the search finished within budget: if completed
// is true and no cover was found, none exists.
func exactMin(masks []*big.Int, full *big.Int, maxK int) (idx []int, found, completed bool) {
	if maxK < 1 {
		return nil, false, true
	}
	// Order configurations by coverage, descending, for better pruning.
	order := make([]int, len(masks))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return popcount(masks[order[a]]) > popcount(masks[order[b]])
	})
	sorted := make([]*big.Int, len(order))
	for i, idx := range order {
		sorted[i] = masks[idx]
	}
	// suffixOr[i] = OR of sorted[i:].
	suffixOr := make([]*big.Int, len(sorted)+1)
	suffixOr[len(sorted)] = new(big.Int)
	for i := len(sorted) - 1; i >= 0; i-- {
		suffixOr[i] = new(big.Int).Or(suffixOr[i+1], sorted[i])
	}
	budget := int64(exactBudget)
	for k := 1; k <= maxK; k++ {
		if idx, ok := searchK(sorted, suffixOr, full, k, &budget); ok {
			out := make([]int, len(idx))
			for i, s := range idx {
				out[i] = order[s]
			}
			return out, true, true
		}
		if budget <= 0 {
			return nil, false, false
		}
	}
	return nil, false, true
}

// searchK looks for exactly k configurations (from sorted) covering full.
func searchK(sorted, suffixOr []*big.Int, full *big.Int, k int, budget *int64) ([]int, bool) {
	chosen := make([]int, 0, k)
	var rec func(start int, covered *big.Int) ([]int, bool)
	rec = func(start int, covered *big.Int) ([]int, bool) {
		if *budget <= 0 {
			return nil, false
		}
		*budget--
		need := k - len(chosen)
		if need == 0 {
			if covered.Cmp(full) == 0 {
				out := make([]int, len(chosen))
				copy(out, chosen)
				return out, true
			}
			return nil, false
		}
		if len(sorted)-start < need {
			return nil, false
		}
		// Prune: even taking everything left cannot complete the cover.
		if new(big.Int).Or(covered, suffixOr[start]).Cmp(full) != 0 {
			return nil, false
		}
		for i := start; i <= len(sorted)-need; i++ {
			chosen = append(chosen, i)
			next := new(big.Int).Or(covered, sorted[i])
			if res, ok := rec(i+1, next); ok {
				return res, true
			}
			chosen = chosen[:len(chosen)-1]
			if *budget <= 0 {
				return nil, false
			}
		}
		return nil, false
	}
	return rec(0, new(big.Int))
}
