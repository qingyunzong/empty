package main

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// MaxTables is the CLI input limit on the number of tables.
const MaxTables = 12

// Edge is an allowed join edge. D is the explicit integer selectivity
// denominator applied to the cross product of the two joined sides.
type Edge struct {
	U, V int
	D    int64
}

// Problem describes a join-ordering instance.
type Problem struct {
	Names []string
	Card  []int64
	Edges []Edge
}

// SubCert is the per-subtree estimation certificate for one connected subset.
type SubCert struct {
	Mask    uint16
	EstCard *big.Int // estimated output cardinality of the subset
	Cost    *big.Int // minimum total cost of a join tree rooted at this subset
	Split   uint16   // chosen left submask (0 for singletons)
	Tree    string   // canonical tree string
}

// Solution holds the DP table and the final answer.
type Solution struct {
	Prob  *Problem
	Certs []SubCert // all connected subsets, ordered by (popcount, mask)
	Full  SubCert   // certificate of the full set
	OK    bool      // false when the join graph is disconnected
}

func bitIndex(b uint16) int {
	i := 0
	for b>>1 != 0 {
		b >>= 1
		i++
	}
	return i
}

func popcount(m uint16) int {
	c := 0
	for m != 0 {
		m &= m - 1
		c++
	}
	return c
}

// Solve runs the subset DP. Only binary trees whose every internal join
// crosses at least one defined edge are considered. Total cost is the sum of
// the estimated output cardinalities of all internal nodes (root included).
func Solve(p *Problem) (*Solution, error) {
	n := len(p.Names)
	if n < 1 || n > MaxTables {
		return nil, fmt.Errorf("table count %d out of range [1,%d]", n, MaxTables)
	}
	size := 1 << n

	adj := make([]uint16, n)
	den := make([][]int64, n)
	for i := range den {
		den[i] = make([]int64, n)
		for j := range den[i] {
			den[i][j] = 1
		}
	}
	for _, e := range p.Edges {
		if e.U == e.V {
			return nil, fmt.Errorf("self edge on table %q", p.Names[e.U])
		}
		if e.D < 1 {
			return nil, fmt.Errorf("edge %q-%q: divisor must be >= 1", p.Names[e.U], p.Names[e.V])
		}
		adj[e.U] |= 1 << e.V
		adj[e.V] |= 1 << e.U
		den[e.U][e.V] = e.D
		den[e.V][e.U] = e.D
	}

	// bnd[mask]: vertices outside mask adjacent to some vertex in mask.
	bnd := make([]uint16, size)
	// prodCard / prodDen: exact big-integer numerator and denominator of the
	// cardinality estimate before the final floor division.
	prodCard := make([]*big.Int, size)
	prodDen := make([]*big.Int, size)
	prodCard[0] = big.NewInt(1)
	prodDen[0] = big.NewInt(1)
	est := make([]*big.Int, size)
	est[0] = big.NewInt(0)
	connected := make([]bool, size)

	for mask := uint16(1); mask < uint16(size); mask++ {
		low := mask & -mask
		v := bitIndex(low)
		rest := mask ^ low

		pc := new(big.Int).Set(prodCard[rest])
		pc.Mul(pc, big.NewInt(p.Card[v]))
		prodCard[mask] = pc

		pd := new(big.Int).Set(prodDen[rest])
		for u := 0; u < n; u++ {
			if rest&(1<<u) != 0 {
				pd.Mul(pd, big.NewInt(den[v][u]))
			}
		}
		prodDen[mask] = pd

		q := new(big.Int).Quo(prodCard[mask], prodDen[mask])
		if q.Sign() == 0 {
			q.SetInt64(1) // any non-empty join result counts as at least one row
		}
		est[mask] = q

		bnd[mask] = bnd[rest] | adj[v]
		connected[mask] = rest == 0
		for u := 0; u < n && !connected[mask]; u++ {
			if mask&(1<<u) != 0 {
				wom := mask ^ (1 << u)
				connected[mask] = connected[wom] && adj[u]&wom != 0
			}
		}
	}

	best := make([]*big.Int, size)
	tree := make([]string, size)
	split := make([]uint16, size)
	for i := 0; i < n; i++ {
		m := uint16(1) << i
		best[m] = big.NewInt(0)
		tree[m] = p.Names[i]
	}

	for mask := uint16(1); mask < uint16(size); mask++ {
		if popcount(mask) < 2 || !connected[mask] {
			continue
		}
		low := mask & -mask
		for sub := (mask - 1) & mask; sub != 0; sub = (sub - 1) & mask {
			if sub&low == 0 {
				continue // each unordered split considered once
			}
			a, b := sub, mask^sub
			if !connected[a] || !connected[b] {
				continue
			}
			if bnd[a]&b == 0 {
				continue // no defined join edge across the split
			}
			cost := new(big.Int).Set(est[mask])
			cost.Add(cost, best[a])
			cost.Add(cost, best[b])
			t := canon(tree[a], tree[b])
			if best[mask] == nil || cost.Cmp(best[mask]) < 0 ||
				(cost.Cmp(best[mask]) == 0 && t < tree[mask]) {
				best[mask] = cost
				tree[mask] = t
				split[mask] = a
			}
		}
	}

	sol := &Solution{Prob: p}
	full := uint16(size) - 1
	if best[full] == nil {
		return sol, nil // disconnected join graph
	}
	sol.OK = true
	for mask := uint16(1); mask < uint16(size); mask++ {
		if !connected[mask] || best[mask] == nil {
			continue
		}
		sol.Certs = append(sol.Certs, SubCert{
			Mask:    mask,
			EstCard: est[mask],
			Cost:    best[mask],
			Split:   split[mask],
			Tree:    tree[mask],
		})
	}
	sort.Slice(sol.Certs, func(i, j int) bool {
		pi, pj := popcount(sol.Certs[i].Mask), popcount(sol.Certs[j].Mask)
		if pi != pj {
			return pi < pj
		}
		return sol.Certs[i].Mask < sol.Certs[j].Mask
	})
	sol.Full = SubCert{Mask: full, EstCard: est[full], Cost: best[full], Split: split[full], Tree: tree[full]}
	return sol, nil
}

// canon builds the canonical tree string of an internal node: children are
// ordered lexicographically so that join commutativity yields one form.
func canon(a, b string) string {
	if b < a {
		a, b = b, a
	}
	return "(" + a + " " + b + ")"
}

// MaskString renders a subset as {A, B, C} using table names.
func (p *Problem) MaskString(mask uint16) string {
	var names []string
	for i := 0; i < len(p.Names); i++ {
		if mask&(1<<i) != 0 {
			names = append(names, p.Names[i])
		}
	}
	return "{" + strings.Join(names, ", ") + "}"
}
