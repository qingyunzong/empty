package joinopt

import "math/big"

// btree is an unordered binary tree used by the exhaustive enumerator.
type btree struct {
	leaf int // table index, or -1 for internal nodes
	l, r *btree
}

// enumerateTrees returns every unordered binary tree whose leaves are the
// tables 0..n-1, each exactly once. Leaves are inserted in fixed order
// 1..n-1 into every position of every tree, so the count is (2n-3)!!.
func enumerateTrees(n int) []*btree {
	trees := []*btree{{leaf: 0}}
	for k := 1; k < n; k++ {
		var next []*btree
		for _, t := range trees {
			next = append(next, insertLeaf(t, k)...)
		}
		trees = next
	}
	return trees
}

func insertLeaf(t *btree, k int) []*btree {
	out := []*btree{{leaf: -1, l: &btree{leaf: k}, r: t}}
	if t.leaf < 0 {
		for _, l := range insertLeaf(t.l, k) {
			out = append(out, &btree{leaf: -1, l: l, r: t.r})
		}
		for _, r := range insertLeaf(t.r, k) {
			out = append(out, &btree{leaf: -1, l: t.l, r: r})
		}
	}
	return out
}

// BruteResult summarizes an exhaustive cross-check.
type BruteResult struct {
	Trees int   // binary trees enumerated: (2n-3)!!
	Valid int   // trees satisfying the declared-edge constraint
	Best  *Plan // minimum-cost canonical valid tree, nil if none
}

// BruteForce enumerates all binary join trees independently of the DP
// search and returns the best valid one. It shares only the cost model
// (exact per-subset estimates), never the DP table, so it is a genuine
// cross-check for small instances.
func (d *DP) BruteForce() *BruteResult {
	res := &BruteResult{}
	for _, t := range enumerateTrees(d.N) {
		res.Trees++
		pl, _ := d.eval(t)
		if pl == nil {
			continue
		}
		res.Valid++
		if res.Best == nil || lessPlan(pl, res.Best) {
			res.Best = pl
		}
	}
	return res
}

// eval evaluates one enumerated tree bottom-up, returning nil when some
// join has no declared edge across its cut.
func (d *DP) eval(t *btree) (*Plan, int) {
	if t.leaf >= 0 {
		return &Plan{Mask: 1 << t.leaf, Cost: new(big.Rat), Canon: d.Prob.Names[t.leaf]}, 1 << t.leaf
	}
	l, lm := d.eval(t.l)
	if l == nil {
		return nil, 0
	}
	r, rm := d.eval(t.r)
	if r == nil {
		return nil, 0
	}
	if d.nbr[lm]&rm == 0 {
		return nil, 0
	}
	mask := lm | rm
	cost := new(big.Rat).Add(l.Cost, r.Cost)
	cost.Add(cost, d.Est[mask])
	left, right := l, r
	if r.Canon < l.Canon {
		left, right = r, l
	}
	return &Plan{Mask: mask, Cost: cost, Canon: canonJoin(l.Canon, r.Canon), Left: left, Right: right}, mask
}
