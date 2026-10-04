package main

import (
	"fmt"
	"math/big"
)

// BruteMaxTables caps exhaustive enumeration: the number of binary trees with
// n labeled leaves is (2n-3)!!, which stays practical up to n = 8.
const BruteMaxTables = 8

type plan struct {
	cost *big.Int
	tree string
}

// connectedMask checks connectivity by BFS over the edge list, independently
// of the DP solver's incremental table.
func connectedMask(p *Problem, mask uint16) bool {
	start := -1
	for i := 0; i < len(p.Names); i++ {
		if mask&(1<<i) != 0 {
			start = i
			break
		}
	}
	if start < 0 {
		return false
	}
	seen := uint16(1) << start
	queue := []int{start}
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		for _, e := range p.Edges {
			var u int
			switch {
			case e.U == v:
				u = e.V
			case e.V == v:
				u = e.U
			default:
				continue
			}
			if mask&(1<<u) != 0 && seen&(1<<u) == 0 {
				seen |= 1 << u
				queue = append(queue, u)
			}
		}
	}
	return seen == mask
}

// hasEdgeBetween reports whether any defined edge crosses the (a, b) cut.
func hasEdgeBetween(p *Problem, a, b uint16) bool {
	for _, e := range p.Edges {
		if (a&(1<<e.U) != 0 && b&(1<<e.V) != 0) ||
			(a&(1<<e.V) != 0 && b&(1<<e.U) != 0) {
			return true
		}
	}
	return false
}

// estCard recomputes the subset cardinality estimate directly from the model
// definition: floor(prod cards / prod internal edge divisors), at least 1.
func estCard(p *Problem, mask uint16) *big.Int {
	num := big.NewInt(1)
	for i := 0; i < len(p.Names); i++ {
		if mask&(1<<i) != 0 {
			num.Mul(num, big.NewInt(p.Card[i]))
		}
	}
	den := big.NewInt(1)
	for _, e := range p.Edges {
		if mask&(1<<e.U) != 0 && mask&(1<<e.V) != 0 {
			den.Mul(den, big.NewInt(e.D))
		}
	}
	q := new(big.Int).Quo(num, den)
	if q.Sign() == 0 {
		q.SetInt64(1)
	}
	return q
}

// brutePlans enumerates every legal binary join tree for every connected
// subset and returns them grouped by subset mask.
func brutePlans(p *Problem) (map[uint16][]plan, error) {
	n := len(p.Names)
	if n < 1 || n > BruteMaxTables {
		return nil, fmt.Errorf("brute force limited to [1,%d] tables, got %d", BruteMaxTables, n)
	}
	memo := map[uint16][]plan{}
	var enum func(mask uint16) []plan
	enum = func(mask uint16) []plan {
		if ps, ok := memo[mask]; ok {
			return ps
		}
		var out []plan
		if popcount(mask) == 1 {
			out = []plan{{big.NewInt(0), p.Names[bitIndex(mask)]}}
		} else if connectedMask(p, mask) {
			low := mask & -mask
			card := estCard(p, mask)
			for sub := (mask - 1) & mask; sub != 0; sub = (sub - 1) & mask {
				if sub&low == 0 {
					continue
				}
				a, b := sub, mask^sub
				if !connectedMask(p, a) || !connectedMask(p, b) {
					continue
				}
				if !hasEdgeBetween(p, a, b) {
					continue
				}
				for _, la := range enum(a) {
					for _, lb := range enum(b) {
						c := new(big.Int).Set(card)
						c.Add(c, la.cost)
						c.Add(c, lb.cost)
						out = append(out, plan{c, canon(la.tree, lb.tree)})
					}
				}
			}
		}
		memo[mask] = out
		return out
	}
	for mask := uint16(1); mask < uint16(1<<n); mask++ {
		enum(mask)
	}
	return memo, nil
}

// bestOf picks the minimum-cost, canonically smallest plan from a list.
func bestOf(all []plan) plan {
	best := all[0]
	for _, pl := range all[1:] {
		if pl.cost.Cmp(best.cost) < 0 ||
			(pl.cost.Cmp(best.cost) == 0 && pl.tree < best.tree) {
			best = pl
		}
	}
	return best
}

// BruteForce enumerates every legal binary join tree over the defined edges
// and returns the minimum-cost canonical plan. It shares no state with the
// DP solver and is used to cross-check it on small instances.
func BruteForce(p *Problem) (*big.Int, string, error) {
	memo, err := brutePlans(p)
	if err != nil {
		return nil, "", err
	}
	full := uint16(1<<len(p.Names)) - 1
	all := memo[full]
	if len(all) == 0 {
		return nil, "", fmt.Errorf("no legal join tree: join graph is disconnected")
	}
	best := bestOf(all)
	return best.cost, best.tree, nil
}
