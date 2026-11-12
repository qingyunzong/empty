package dataeng

import (
	"math/big"
	"testing"
)

// partitionFeasible reports whether the partition admits a block ordering that
// respects every original edge. Contracting each block yields a directed graph
// on block labels; the partition is feasible exactly when that quotient graph
// is acyclic (Kahn's algorithm). Labels themselves carry no rank meaning.
func partitionFeasible(label []int, edges []dedupEdge, blockCount int) bool {
	indeg := make([]int, blockCount)
	quotient := make([][]int, blockCount)
	seen := make(map[[2]int]bool)
	for _, e := range edges {
		u := label[e.from]
		v := label[e.to]
		if u == v {
			continue
		}
		key := [2]int{u, v}
		if seen[key] {
			continue
		}
		seen[key] = true
		quotient[u] = append(quotient[u], v)
		indeg[v]++
	}
	queue := make([]int, 0, blockCount)
	for b := 0; b < blockCount; b++ {
		if indeg[b] == 0 {
			queue = append(queue, b)
		}
	}
	visited := 0
	for head := 0; head < len(queue); head++ {
		b := queue[head]
		visited++
		for _, next := range quotient[b] {
			indeg[next]--
			if indeg[next] == 0 {
				queue = append(queue, next)
			}
		}
	}
	return visited == blockCount
}

// enumerateReference is the independent exponential-time reference required
// for n <= 7. It enumerates every set partition (restricted growth strings),
// keeps partitions whose block quotient graph is acyclic under every original
// edge, assigns each block its weighted mean, and directly minimizes the
// objective. It shares no code with the production solver and checks the
// returned vector, not only its cost.
func enumerateReference(t *testing.T, y, w []*big.Rat, edges []dedupEdge) ([]*big.Rat, *big.Rat) {
	t.Helper()
	n := len(y)
	if n > 7 {
		t.Fatalf("reference enumeration is only valid for n <= 7, got %d", n)
	}

	var bestX []*big.Rat
	bestF := (*big.Rat)(nil)

	evaluate := func(label []int) {
		blockCount := 0
		for _, b := range label {
			if b+1 > blockCount {
				blockCount = b + 1
			}
		}
		num := make([]*big.Rat, blockCount)
		den := make([]*big.Rat, blockCount)
		for b := 0; b < blockCount; b++ {
			num[b] = new(big.Rat)
			den[b] = new(big.Rat)
		}
		for i, b := range label {
			num[b].Add(num[b], new(big.Rat).Mul(w[i], y[i]))
			den[b].Add(den[b], w[i])
		}
		mean := make([]*big.Rat, blockCount)
		for b := 0; b < blockCount; b++ {
			mean[b] = new(big.Rat).Quo(num[b], den[b])
		}
		if !partitionMeansFeasible(label, edges, blockCount, mean) {
			return
		}
		x := make([]*big.Rat, n)
		f := new(big.Rat)
		for i, b := range label {
			x[i] = new(big.Rat).Set(mean[b])
			delta := new(big.Rat).Sub(x[i], y[i])
			f.Add(f, new(big.Rat).Mul(w[i], new(big.Rat).Mul(delta, delta)))
		}
		if bestF == nil || f.Cmp(bestF) < 0 {
			bestF = f
			bestX = x
		}
	}

	var rgs func(pos, next int, label []int)
	rgs = func(pos, next int, label []int) {
		if pos == n {
			evaluate(label)
			return
		}
		for b := 0; b < next; b++ {
			label[pos] = b
			rgs(pos+1, next, label)
		}
		label[pos] = next
		rgs(pos+1, next+1, label)
	}
	rgs(0, 0, make([]int, n))

	if bestX == nil {
		t.Fatalf("reference enumerator found no feasible partition")
	}
	return bestX, bestF
}

// partitionMeansFeasible checks the actual assigned means against every edge.
// A quotient DAG alone is insufficient: each block receives a fixed weighted
// mean, so an edge between different blocks requires the concrete mean of the
// source block to not exceed the concrete mean of the target block.
func partitionMeansFeasible(label []int, edges []dedupEdge, blockCount int, mean []*big.Rat) bool {
	if !partitionFeasible(label, edges, blockCount) {
		return false
	}
	for _, e := range edges {
		if label[e.from] != label[e.to] && mean[label[e.from]].Cmp(mean[label[e.to]]) > 0 {
			return false
		}
	}
	return true
}

func assertVectorMatchesReference(t *testing.T, g *Graph, y, w []*big.Rat, res *Result) {
	t.Helper()
	refX, refF := enumerateReference(t, y, w, g.edges)
	for i := 0; i < g.N(); i++ {
		if res.x[i].Cmp(refX[i]) != 0 {
			t.Fatalf("node %s: solver x=%s differs from reference x=%s",
				g.ids[i], res.x[i].RatString(), refX[i].RatString())
		}
	}
	if res.f.Cmp(refF) != 0 {
		t.Fatalf("objective mismatch: solver F=%s reference F=%s", res.f.RatString(), refF.RatString())
	}
}
