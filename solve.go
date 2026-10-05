package joinopt

import (
	"math/big"
	"math/bits"
	"sort"
)

// Plan is a canonical binary join tree for the tables in Mask.
// Cost is the total intermediate-result cost of the best plan for Mask;
// Canon is the canonical parenthesized string (children ordered
// lexicographically at every node).
type Plan struct {
	Mask  int
	Cost  *big.Rat
	Canon string
	Left  *Plan
	Right *Plan
}

func canonJoin(a, b string) string {
	if b < a {
		a, b = b, a
	}
	return "(" + a + " ⋈ " + b + ")"
}

// lessPlan orders plans by cost, breaking ties by canonical string so the
// optimum is unique and deterministic.
func lessPlan(a, b *Plan) bool {
	if c := a.Cost.Cmp(b.Cost); c != 0 {
		return c < 0
	}
	return a.Canon < b.Canon
}

// DP holds the dynamic-programming tables for a Problem: exact per-subset
// cardinality estimates and the best canonical plan per connected subset.
type DP struct {
	Prob *Problem
	N    int
	Est  []*big.Rat // Est[mask]: exact estimated cardinality of the join over mask

	conn []bool
	nbr  []int // nbr[mask]: union of adjacency of tables in mask
	best []*Plan
}

// NewDP solves p exactly by DP over connected subsets.
func NewDP(p *Problem) *DP {
	n := len(p.Names)
	size := 1 << n
	d := &DP{
		Prob: p,
		N:    n,
		Est:  make([]*big.Rat, size),
		conn: make([]bool, size),
		nbr:  make([]int, size),
		best: make([]*Plan, size),
	}
	d.Est[0] = big.NewRat(1, 1)
	for mask := 1; mask < size; mask++ {
		low := mask & -mask
		k := bits.TrailingZeros(uint(low))
		rest := mask ^ low
		est := new(big.Rat).Set(d.Est[rest])
		est.Mul(est, new(big.Rat).SetInt64(p.Card[k]))
		for m := p.adj[k] & rest; m != 0; m &= m - 1 {
			est.Mul(est, p.sel[edgeKey(k, bits.TrailingZeros(uint(m)))])
		}
		d.Est[mask] = est
		d.nbr[mask] = d.nbr[rest] | p.adj[k]
	}
	for mask := 1; mask < size; mask++ {
		d.conn[mask] = connected(mask, p.adj)
	}
	for mask := 1; mask < size; mask++ {
		if !d.conn[mask] {
			continue
		}
		if mask&(mask-1) == 0 {
			d.best[mask] = &Plan{Mask: mask, Cost: new(big.Rat), Canon: p.Names[bits.TrailingZeros(uint(mask))]}
			continue
		}
		low := mask & -mask
		for a := (mask - 1) & mask; a != 0; a = (a - 1) & mask {
			if a&low == 0 {
				continue // each unordered bipartition once
			}
			b := mask ^ a
			if !d.conn[a] || !d.conn[b] {
				continue
			}
			if d.nbr[a]&b == 0 {
				continue // no declared edge across the cut
			}
			pa, pb := d.best[a], d.best[b]
			cost := new(big.Rat).Add(pa.Cost, pb.Cost)
			cost.Add(cost, d.Est[mask])
			left, right := pa, pb
			if pb.Canon < pa.Canon {
				left, right = pb, pa
			}
			cand := &Plan{Mask: mask, Cost: cost, Canon: canonJoin(pa.Canon, pb.Canon), Left: left, Right: right}
			if d.best[mask] == nil || lessPlan(cand, d.best[mask]) {
				d.best[mask] = cand
			}
		}
	}
	return d
}

// connected reports whether mask induces a connected subgraph (BFS).
func connected(mask int, adj []int) bool {
	seen := mask & -mask
	frontier := seen
	for frontier != 0 {
		nb := 0
		for f := frontier; f != 0; f &= f - 1 {
			nb |= adj[bits.TrailingZeros(uint(f&-f))]
		}
		nb &= mask &^ seen
		seen |= nb
		frontier = nb
	}
	return seen == mask
}

// Optimal returns the minimum-cost canonical plan, or false when the join
// graph is disconnected and no valid plan exists.
func (d *DP) Optimal() (*Plan, bool) {
	full := 1<<d.N - 1
	if d.best[full] == nil {
		return nil, false
	}
	return d.best[full], true
}

// Best returns the best plan for a connected subset, or nil.
func (d *DP) Best(mask int) *Plan { return d.best[mask] }

// Connected reports whether mask induces a connected subgraph.
func (d *DP) Connected(mask int) bool { return d.conn[mask] }

// Certificate is the per-subtree estimation record: exact estimated
// cardinality, best achievable cost, and the canonical best plan.
type Certificate struct {
	Mask   int
	Tables []string
	Est    *big.Rat
	Cost   *big.Rat
	Canon  string
}

// Certificates returns one certificate per connected subset, ordered by
// increasing subset size, then bitmask.
func (d *DP) Certificates() []Certificate {
	var certs []Certificate
	for mask := 1; mask < 1<<d.N; mask++ {
		if !d.conn[mask] {
			continue
		}
		var tables []string
		for m := mask; m != 0; m &= m - 1 {
			tables = append(tables, d.Prob.Names[bits.TrailingZeros(uint(m&-m))])
		}
		certs = append(certs, Certificate{
			Mask:   mask,
			Tables: tables,
			Est:    d.Est[mask],
			Cost:   d.best[mask].Cost,
			Canon:  d.best[mask].Canon,
		})
	}
	sort.Slice(certs, func(i, j int) bool {
		pi := bits.OnesCount(uint(certs[i].Mask))
		pj := bits.OnesCount(uint(certs[j].Mask))
		if pi != pj {
			return pi < pj
		}
		return certs[i].Mask < certs[j].Mask
	})
	return certs
}
