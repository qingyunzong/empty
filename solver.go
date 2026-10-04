package main

import (
	"math"
	"sort"
	"time"
)

// objective is compared lexicographically: cost first, then test count.
type objective struct {
	cost  int
	count int
}

func (a objective) better(b objective) bool {
	return a.cost < b.cost || (a.cost == b.cost && a.count < b.count)
}

var infObjective = objective{math.MaxInt, math.MaxInt}

// result is the outcome of an exact solve.
type result struct {
	feasible bool
	obj      objective
	tests    []int // selected test indices, sorted

	initialLower int // cost lower bound at the root
	initialUpper int // greedy incumbent cost at the root (MaxInt if none)

	nodes   int
	pruned  int
	elapsed time.Duration
}

// solve finds a minimum-cost (then minimum-count) selection of tests that
// covers the whole universe, is closed under requires, and fits the time
// limit. It uses greedy seeding plus depth-first branch and bound.
func solve(m *model) result {
	start := time.Now()
	r := result{}

	uncoverable := m.uncoverable()
	if len(uncoverable) > 0 {
		r.elapsed = time.Since(start)
		return r
	}

	n := len(m.spec.Tests)
	nelem := len(m.elemNames)

	// Root lower bound on additional cost.
	r.initialLower = costLowerBound(m, m.full, 0)

	// Greedy incumbent.
	best := infObjective
	var bestMask uint32
	if mask, obj, ok := greedy(m); ok {
		best, bestMask = obj, mask
		r.initialUpper = obj.cost
	} else {
		r.initialUpper = math.MaxInt
	}

	// Iterative-deepening-free DFS over positions 0..n-1.
	type frame struct {
		pos      int
		selected uint32
		covered  bitset
		cost     int
		count    int
		dur      int
		included bool // whether the include branch was already tried
	}
	root := frame{pos: 0, covered: newBitset(nelem)}
	stack := []frame{root}

	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		r.nodes++

		uncovered := m.full.andNot(f.covered)
		if uncovered.empty() {
			obj := objective{f.cost, f.count}
			if obj.better(best) {
				best, bestMask = obj, f.selected
			}
			continue
		}
		if f.pos == n {
			continue
		}

		// Prune: remaining tests cannot cover what is left.
		if !m.suffixUnion[f.pos].covers(uncovered) {
			r.pruned++
			continue
		}
		// Prune: cost lower bound cannot beat the incumbent.
		lb := costLowerBound(m, uncovered, f.pos)
		if f.cost+lb > best.cost {
			r.pruned++
			continue
		}
		if f.cost+lb == best.cost {
			maxCov := m.suffixMaxCov[f.pos]
			countLB := 0
			if maxCov > 0 {
				countLB = (uncovered.count() + maxCov - 1) / maxCov
			}
			if f.count+countLB >= best.count {
				r.pruned++
				continue
			}
		}

		bit := uint32(1) << uint(f.pos)
		if f.selected&bit != 0 {
			// Already forced in by an earlier closure; move on.
			f.pos++
			stack = append(stack, f)
			continue
		}

		// Exclude branch (pushed first, explored second).
		ex := f
		ex.pos++
		stack = append(stack, ex)

		// Include branch: add the closure of test pos.
		delta := m.closure[f.pos] &^ f.selected
		dCost, dDur, dCount := 0, 0, 0
		for j := 0; j < n; j++ {
			if delta&(1<<uint(j)) != 0 {
				dCost += m.cost[j]
				dDur += m.dur[j]
				dCount++
			}
		}
		if f.dur+dDur <= m.spec.TimeLimit && f.cost+dCost <= best.cost {
			in := frame{
				pos:      f.pos + 1,
				selected: f.selected | delta,
				covered:  f.covered.clone(),
				cost:     f.cost + dCost,
				count:    f.count + dCount,
				dur:      f.dur + dDur,
			}
			in.covered.or(m.closureCov[f.pos])
			stack = append(stack, in)
		}
	}

	r.elapsed = time.Since(start)
	if best == infObjective {
		return r
	}
	r.feasible = true
	r.obj = best
	for j := 0; j < n; j++ {
		if bestMask&(1<<uint(j)) != 0 {
			r.tests = append(r.tests, j)
		}
	}
	sort.Ints(r.tests)
	return r
}

// costLowerBound bounds the additional cost needed to cover the uncovered
// set using tests at positions >= pos. For every uncovered element e, the
// cheapest test covering e costs minElemCost[e]; a single test can pay for
// at most maxCov of them, so the sum divided by maxCov is a valid bound.
func costLowerBound(m *model, uncovered bitset, pos int) int {
	maxCov := m.suffixMaxCov[pos]
	if maxCov == 0 {
		return 0
	}
	sum := 0
	for _, e := range uncovered.indices() {
		if m.minElemCost[e] > 0 {
			sum += m.minElemCost[e]
		}
	}
	return (sum + maxCov - 1) / maxCov
}

// greedy builds an initial feasible selection by repeatedly adding the
// closure with the smallest cost-per-newly-covered-element ratio.
func greedy(m *model) (uint32, objective, bool) {
	n := len(m.spec.Tests)
	var selected uint32
	covered := newBitset(len(m.elemNames))
	cost, count, dur := 0, 0, 0

	for !covered.covers(m.full) {
		bestT, bestGain := -1, 0
		bestCost, bestCount := 0, 0
		for t := 0; t < n; t++ {
			delta := m.closure[t] &^ selected
			if delta == 0 {
				continue
			}
			dCost, dDur, dCount := 0, 0, 0
			for j := 0; j < n; j++ {
				if delta&(1<<uint(j)) != 0 {
					dCost += m.cost[j]
					dDur += m.dur[j]
					dCount++
				}
			}
			if dur+dDur > m.spec.TimeLimit {
				continue
			}
			gain := m.closureCov[t].andNot(covered).count()
			if gain == 0 {
				continue
			}
			// Minimize dCost/gain, then dCount, without floating point.
			if bestT < 0 ||
				dCost*bestGain < bestCost*gain ||
				(dCost*bestGain == bestCost*gain && dCount < bestCount) {
				bestT, bestGain = t, gain
				bestCost, bestCount = dCost, dCount
			}
		}
		if bestT < 0 {
			return 0, infObjective, false
		}
		delta := m.closure[bestT] &^ selected
		for j := 0; j < n; j++ {
			if delta&(1<<uint(j)) != 0 {
				cost += m.cost[j]
				dur += m.dur[j]
				count++
			}
		}
		selected |= delta
		covered.or(m.closureCov[bestT])
	}
	return selected, objective{cost, count}, true
}

// exhaustive checks every subset of tests exactly. It is used to verify the
// branch-and-bound solver on small instances.
func exhaustive(m *model) result {
	start := time.Now()
	r := result{}
	n := len(m.spec.Tests)
	best := infObjective
	var bestMask uint32

	total := uint64(1) << uint(n)
	for mask := uint64(0); mask < total; mask++ {
		r.nodes++
		// Closure under requires.
		ok := true
		for i := 0; i < n; i++ {
			if mask&(1<<uint(i)) != 0 && uint64(m.closure[i])&^mask != 0 {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		covered := newBitset(len(m.elemNames))
		cost, count, dur := 0, 0, 0
		for i := 0; i < n; i++ {
			if mask&(1<<uint(i)) != 0 {
				covered.or(m.cov[i])
				cost += m.cost[i]
				dur += m.dur[i]
				count++
			}
		}
		if dur > m.spec.TimeLimit || !covered.covers(m.full) {
			continue
		}
		obj := objective{cost, count}
		if obj.better(best) {
			best, bestMask = obj, uint32(mask)
		}
	}

	r.elapsed = time.Since(start)
	if best == infObjective {
		return r
	}
	r.feasible = true
	r.obj = best
	for j := 0; j < n; j++ {
		if bestMask&(1<<uint(j)) != 0 {
			r.tests = append(r.tests, j)
		}
	}
	return r
}
