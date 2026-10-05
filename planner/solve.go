package planner

import (
	"math"
	"sort"
)

// Solution is the outcome of solving a prepared spec.
type Solution struct {
	Feasible bool
	Cost     int64
	Rules    []int               // selected rule indices, input order
	Assign   map[int]map[int]int // rule index -> action index -> count
}

// RuleUsage returns total assigned units per selected rule.
func (s *Solution) RuleUsage() map[int]int {
	usage := map[int]int{}
	for r, per := range s.Assign {
		for _, n := range per {
			usage[r] += n
		}
	}
	return usage
}

// solve finds a minimum-cost feasible selection. Ties are broken by the
// lexicographically smallest sorted rule-ID list.
func (p *prepared) solve() *Solution {
	sol := &Solution{Cost: math.MaxInt64}
	if !p.quotaOK() {
		return sol
	}
	// Order eligible rules by (cost, id) so cheap rules are explored first.
	ord := append([]int(nil), p.elig...)
	sort.Slice(ord, func(i, j int) bool {
		a, b := p.spec.Rules[ord[i]], p.spec.Rules[ord[j]]
		if a.Cost != b.Cost {
			return a.Cost < b.Cost
		}
		return a.ID < b.ID
	})
	m := len(ord)

	suffixCover := make([]uint64, m+1)
	suffixCap := make([]int, m+1)
	for i := m - 1; i >= 0; i-- {
		suffixCover[i] = suffixCover[i+1] | p.ruleActionMask[ord[i]]
		suffixCap[i] = min(p.totalDemand, suffixCap[i+1]+p.effCap(ord[i]))
	}

	best := &Solution{Cost: math.MaxInt64}
	var bestIDs []string

	var rec func(pos int, cost int64, sel uint64, cover uint64, capSum int)
	rec = func(pos int, cost int64, sel uint64, cover uint64, capSum int) {
		if cost > best.Cost {
			return
		}
		if (cover|suffixCover[pos])&p.demandMask != p.demandMask {
			return
		}
		if min(p.totalDemand, capSum+suffixCap[pos]) < p.totalDemand {
			return
		}
		if pos == m {
			// Enable-prerequisites are verified at the leaf.
			for bits := sel; bits != 0; bits &= bits - 1 {
				r := bitsTrailing(bits)
				if p.requiresMask[r]&^sel != 0 {
					return
				}
			}
			var selList []int
			for bits := sel; bits != 0; bits &= bits - 1 {
				selList = append(selList, bitsTrailing(bits))
			}
			assign, ok := p.assign(selList)
			if !ok {
				return
			}
			ids := p.sortedIDs(sel)
			if cost < best.Cost || (cost == best.Cost && lessIDs(ids, bestIDs)) {
				best.Cost = cost
				best.Feasible = true
				best.Rules = selList
				best.Assign = assign
				bestIDs = ids
			}
			return
		}
		r := ord[pos]
		bit := uint64(1) << uint(r)
		if p.excludesMask[r]&sel == 0 {
			rec(pos+1, cost+p.spec.Rules[r].Cost, sel|bit,
				cover|p.ruleActionMask[r], min(p.totalDemand, capSum+p.effCap(r)))
		}
		rec(pos+1, cost, sel, cover, capSum)
	}
	rec(0, 0, 0, 0, 0)
	return best
}

// lowerBound is a relaxation: every demand action must be covered by at least
// one selected eligible rule, so the optimum costs at least the maximum, over
// demand actions, of the cheapest eligible rule covering that action.
func (p *prepared) lowerBound() int64 {
	var lb int64
	for _, a := range p.demandActions {
		best := int64(math.MaxInt64)
		for _, r := range p.elig {
			if p.ruleActionMask[r]&(1<<uint(a)) != 0 && p.spec.Rules[r].Cost < best {
				best = p.spec.Rules[r].Cost
			}
		}
		if best == math.MaxInt64 {
			return 0 // uncoverable; infeasibility reported separately
		}
		if best > lb {
			lb = best
		}
	}
	return lb
}

// greedyUpperBound builds a feasible selection greedily (respecting mutex and
// pulling in prerequisite closures) and returns its cost, or nil if the
// heuristic fails to find any feasible selection.
func (p *prepared) greedyUpperBound() *int64 {
	if !p.quotaOK() {
		return nil
	}
	var sel uint64
	var cost int64
	for {
		if p.coverOf(sel)&p.demandMask == p.demandMask && p.capOf(sel) >= p.totalDemand {
			var selList []int
			for bits := sel; bits != 0; bits &= bits - 1 {
				selList = append(selList, bitsTrailing(bits))
			}
			if _, ok := p.assign(selList); ok {
				c := cost
				return &c
			}
		}
		bestRule, bestAdded, bestGain, bestCost := -1, uint64(0), -1.0, int64(0)
		for _, r := range p.elig {
			bit := uint64(1) << uint(r)
			if sel&bit != 0 || p.excludesMask[r]&sel != 0 {
				continue
			}
			closure := p.requiresClosure[r] | bit
			if closure&sel == closure { // already fully selected
				continue
			}
			conflict := false
			var addCost int64
			var addCover uint64
			for bits := closure; bits != 0; bits &= bits - 1 {
				q := bitsTrailing(bits)
				qbit := uint64(1) << uint(q)
				if sel&qbit != 0 {
					continue
				}
				if p.excludesMask[q]&(sel|closure&^qbit) != 0 || p.excludesMask[q]&qbit != 0 {
					conflict = true
					break
				}
				if !p.eligible[q] {
					conflict = true
					break
				}
				addCost += p.spec.Rules[q].Cost
				addCover |= p.ruleActionMask[q]
			}
			if conflict {
				continue
			}
			gain := 0
			for _, a := range p.demandActions {
				abit := uint64(1) << uint(a)
				if addCover&abit != 0 && p.coverOf(sel)&abit == 0 {
					gain++
				}
			}
			if gain == 0 && p.coverOf(sel)&p.demandMask == p.demandMask {
				gain = 1 // allow capacity-only additions once coverage is met
			}
			score := float64(gain) / (float64(addCost) + 1)
			if score > bestGain {
				bestRule, bestAdded, bestGain, bestCost = r, closure, score, addCost
			}
		}
		if bestRule < 0 {
			return nil
		}
		sel |= bestAdded
		cost += bestCost
	}
}

func (p *prepared) coverOf(sel uint64) uint64 {
	var cover uint64
	for bits := sel; bits != 0; bits &= bits - 1 {
		cover |= p.ruleActionMask[bitsTrailing(bits)]
	}
	return cover
}

func (p *prepared) capOf(sel uint64) int {
	sum := 0
	for bits := sel; bits != 0; bits &= bits - 1 {
		sum = min(p.totalDemand, sum+p.effCap(bitsTrailing(bits)))
	}
	return sum
}
