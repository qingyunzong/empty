package dataeng

import "math/big"

// closureResult reports a minimum-weight lower-closed subset of an induced
// sub-poset. weight is the exact minimum of sum_{i in S} a_i; inside marks the
// chosen subset using global node indices.
type closureResult struct {
	weight *big.Rat
	inside []bool
}

// minWeightLowerClosure solves min{sum_{i in S} a_i : S lower-closed inside
// nodes} with one exact max-flow reduction.
//
// Lower-closed means: for every constraint u <= v with both endpoints in the
// induced node set, v in S forces u in S. Negating the node weights turns the
// problem into the standard maximum-weight closure problem:
//
//	b_i = -a_i
//	  b_i > 0 : source -> i with capacity b_i
//	  b_i < 0 : i -> sink with capacity -b_i
//	  v in S => u in S : infinite-capacity arc u -> v (a cut with u source-side
//	    and v sink-side is forbidden, so a source-reachable v forces u reachable)
//
// With P the total positive b_i capacity and f the exact maximum flow, the
// maximum closure weight is P-f, so the requested minimum is f-P. Nodes
// reachable from the source on the residual network form an optimal closure.
func minWeightLowerClosure(g *Graph, nodes []int, a []*big.Rat) closureResult {
	m := len(nodes)
	empty := closureResult{
		weight: new(big.Rat),
		inside: make([]bool, len(g.ids)),
	}
	// With no positive b_i (i.e. no negative a_i) every non-empty set has
	// non-negative cost; the empty lower-closed set is optimal at weight zero.
	hasNegative := false
	for _, global := range nodes {
		if a[global].Sign() < 0 {
			hasNegative = true
			break
		}
	}
	if !hasNegative {
		return empty
	}

	local := make([]int, len(g.ids))
	for i := range local {
		local[i] = -1
	}
	for k, global := range nodes {
		local[global] = k
	}

	source := m
	sink := m + 1
	dinic := newRationalDinic(m + 2)

	positiveSum := new(big.Rat)
	for _, global := range nodes {
		switch a[global].Sign() {
		case -1:
			// b_i = -a_i > 0: source -> i with capacity -a_i.
			dinic.addEdge(source, local[global], new(big.Rat).Neg(a[global]))
			positiveSum.Add(positiveSum, new(big.Rat).Neg(a[global]))
		case 1:
			// b_i = -a_i < 0: i -> sink with capacity a_i.
			dinic.addEdge(local[global], sink, a[global])
		}
	}

	// Infinite capacity must dominate any finite cut; the all-sink-side cut has
	// capacity positiveSum, so positiveSum itself is an unbounded-enough INF.
	inf := ratCopy(positiveSum)
	inNodeSet := func(i int) bool { return local[i] >= 0 }
	for _, e := range g.edges {
		if inNodeSet(e.from) && inNodeSet(e.to) {
			// Lower-closed requirement: for edge u -> v (x_u <= x_v),
			// v in S forces u in S. In the min-cut construction an infinite
			// arc u -> v makes a cut with u on the source side and v on the
			// sink side impossible, which is exactly the implication v => u.
			dinic.addEdge(local[e.from], local[e.to], inf)
		}
	}

	flow := dinic.maxFlow(source, sink)
	reachable := dinic.reachableFrom(source)

	inside := make([]bool, len(g.ids))
	for k, global := range nodes {
		inside[global] = reachable[k]
	}
	return closureResult{
		// Minimum weight = mincut_capacity - (sum of source-arc capacities).
		// mincut_capacity equals the maximum flow value.
		weight: ratSub(flow, positiveSum),
		inside: inside,
	}
}
