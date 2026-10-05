package main

// Pair identifies a (dim,value) x (dim,value) combination with D1 < D2.
type Pair struct {
	D1, V1, D2, V2 int
}

// DimVal is one half of a pair.
type DimVal struct {
	Dim, Val int
}

// AllPairs enumerates every value pair across every dimension pair.
func AllPairs(s *Spec) []Pair {
	var out []Pair
	for d1 := 0; d1 < len(s.Dimensions); d1++ {
		for d2 := d1 + 1; d2 < len(s.Dimensions); d2++ {
			for v1 := range s.Dimensions[d1].Values {
				for v2 := range s.Dimensions[d2].Values {
					out = append(out, Pair{d1, v1, d2, v2})
				}
			}
		}
	}
	return out
}

// search finds a complete legal config extending the fixed assignments.
// It is a complete backtracking search: failure proves no such config exists.
func search(cs *compiledSpec, fixed []DimVal) ([]int, bool) {
	n := len(cs.spec.Dimensions)
	cfg := make([]int, n)
	for i := range cfg {
		cfg[i] = -1
	}
	for _, fv := range fixed {
		cfg[fv.Dim] = fv.Val
	}
	if !cs.consistentPartial(cfg) {
		return nil, false
	}
	var bt func(d int) bool
	bt = func(d int) bool {
		for d < n && cfg[d] != -1 {
			d++
		}
		if d == n {
			return cs.Legal(cfg)
		}
		for v := range cs.spec.Dimensions[d].Values {
			cfg[d] = v
			if cs.consistentPartial(cfg) && bt(d+1) {
				return true
			}
		}
		cfg[d] = -1
		return false
	}
	if bt(0) {
		out := make([]int, n)
		copy(out, cfg)
		return out, true
	}
	return nil, false
}

// Coverable reports whether some legal config contains both pair endpoints.
func Coverable(cs *compiledSpec, p Pair) bool {
	_, ok := search(cs, []DimVal{{p.D1, p.V1}, {p.D2, p.V2}})
	return ok
}

// pairsOf returns all pairs contained in a complete config.
func pairsOf(cfg []int) []Pair {
	var out []Pair
	for d1 := 0; d1 < len(cfg); d1++ {
		for d2 := d1 + 1; d2 < len(cfg); d2++ {
			out = append(out, Pair{d1, cfg[d1], d2, cfg[d2]})
		}
	}
	return out
}

// GreedyCover builds at most max legal configs covering every pair in targets.
// It returns the configs, the covering config index per pair, and any target
// pairs left uncovered because the config cap was reached.
func GreedyCover(cs *compiledSpec, targets []Pair, max int) ([][]int, map[Pair]int, []Pair) {
	uncovered := make(map[Pair]bool, len(targets))
	for _, p := range targets {
		uncovered[p] = true
	}
	cover := make(map[Pair]int, len(targets))
	var configs [][]int

	for len(uncovered) > 0 && len(configs) < max {
		// Seed with the first still-uncovered pair (deterministic order).
		var seed Pair
		for _, p := range targets {
			if uncovered[p] {
				seed = p
				break
			}
		}
		cfg := greedyExtend(cs, seed, uncovered)
		idx := len(configs)
		configs = append(configs, cfg)
		for _, p := range pairsOf(cfg) {
			if uncovered[p] {
				delete(uncovered, p)
				cover[p] = idx
			}
		}
	}
	var leftover []Pair
	for _, p := range targets {
		if uncovered[p] {
			leftover = append(leftover, p)
		}
	}
	return configs, cover, leftover
}

// greedyExtend builds a legal config containing seed, choosing values that
// cover as many currently-uncovered pairs as possible. Every chosen value is
// guarded by an extendability check, so the result is always legal.
func greedyExtend(cs *compiledSpec, seed Pair, uncovered map[Pair]bool) []int {
	n := len(cs.spec.Dimensions)
	fixed := []DimVal{{seed.D1, seed.V1}, {seed.D2, seed.V2}}
	assigned := make([]bool, n)
	assigned[seed.D1] = true
	assigned[seed.D2] = true
	cur := make([]int, n)
	for i := range cur {
		cur[i] = -1
	}
	cur[seed.D1] = seed.V1
	cur[seed.D2] = seed.V2

	for d := 0; d < n; d++ {
		if assigned[d] {
			continue
		}
		bestV, bestGain := -1, -1
		for v := range cs.spec.Dimensions[d].Values {
			cand := append(append([]DimVal{}, fixed...), DimVal{d, v})
			if _, ok := search(cs, cand); !ok {
				continue // would make completion impossible
			}
			gain := 0
			for p := range uncovered {
				if (p.D1 == d && p.V1 == v && assigned[p.D2] && cur[p.D2] == p.V2) ||
					(p.D2 == d && p.V2 == v && assigned[p.D1] && cur[p.D1] == p.V1) {
					gain++
				}
			}
			if gain > bestGain {
				bestGain, bestV = gain, v
			}
		}
		if bestV == -1 {
			// Cannot happen: seed is coverable, so some value extends.
			// Fall back to the raw search result for safety.
			full, _ := search(cs, fixed)
			return full
		}
		cur[d] = bestV
		assigned[d] = true
		fixed = append(fixed, DimVal{d, bestV})
	}
	return cur
}

// EnumerateLegal lists every legal complete config, stopping early (and
// reporting ok=false) once more than limit configs have been found.
func EnumerateLegal(cs *compiledSpec, limit int) ([][]int, bool) {
	n := len(cs.spec.Dimensions)
	cfg := make([]int, n)
	var out [][]int
	var bt func(d int) bool
	bt = func(d int) bool {
		if d == n {
			if cs.Legal(cfg) {
				out = append(out, append([]int{}, cfg...))
				if len(out) > limit {
					return false
				}
			}
			return true
		}
		for v := range cs.spec.Dimensions[d].Values {
			cfg[d] = v
			if cs.consistentPartial(cfg) && !bt(d+1) {
				return false
			}
		}
		return true
	}
	if !bt(0) {
		return nil, false
	}
	return out, true
}

// ExactMinCover finds a minimum-size set of legal configs covering all target
// pairs, by enumerating subsets of the legal-config universe in increasing
// size. upperBound prunes the search: only sizes below it are tried; if none
// covers, upperBound is optimal. Returns the optimal configs and size.
func ExactMinCover(legal [][]int, targets []Pair, upperBound int) ([][]int, int) {
	// Bitmask of covered target pairs per legal config.
	coverMask := make([][]uint64, len(legal))
	index := make(map[Pair]int, len(targets))
	for i, p := range targets {
		index[p] = i
	}
	fullWords := (len(targets) + 63) / 64
	var full []uint64
	if fullWords > 0 {
		full = make([]uint64, fullWords)
		for i := range targets {
			full[i/64] |= 1 << uint(i%64)
		}
	}
	for ci, cfg := range legal {
		mask := make([]uint64, fullWords)
		for _, p := range pairsOf(cfg) {
			if ti, ok := index[p]; ok {
				mask[ti/64] |= 1 << uint(ti%64)
			}
		}
		coverMask[ci] = mask
	}
	coversAll := func(mask []uint64) bool {
		for w := range full {
			if mask[w] != full[w] {
				return false
			}
		}
		return true
	}
	// Empty target set: zero configs suffice.
	if len(targets) == 0 {
		return nil, 0
	}
	// Enumerate combinations of increasing size below upperBound.
	for k := 1; k < upperBound && k <= len(legal); k++ {
		var best []int
		chosen := make([]int, 0, k)
		acc := make([]uint64, fullWords)
		var rec func(start int) bool
		rec = func(start int) bool {
			if len(chosen) == k {
				if coversAll(acc) {
					best = append([]int{}, chosen...)
					return true
				}
				return false
			}
			need := k - len(chosen)
			for i := start; i <= len(legal)-need; i++ {
				for w := range acc {
					acc[w] |= coverMask[i][w]
				}
				chosen = append(chosen, i)
				if rec(i + 1) {
					return true
				}
				chosen = chosen[:len(chosen)-1]
				// restore acc: recompute from chosen (k is small)
				for w := range acc {
					acc[w] = 0
				}
				for _, c := range chosen {
					for w := range acc {
						acc[w] |= coverMask[c][w]
					}
				}
			}
			return false
		}
		if rec(0) {
			out := make([][]int, len(best))
			for i, ci := range best {
				out[i] = legal[ci]
			}
			return out, k
		}
	}
	// No cover smaller than upperBound exists: upperBound is optimal.
	return nil, upperBound
}
