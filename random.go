package graphtest

import (
	"fmt"
	"math/rand"
)

// RandomChain generates a legal transformation chain of n steps starting
// from g, using a PRNG seeded with seed. The returned chain records the
// seed and every step, so the run is fully reproducible; the final graph is
// returned alongside.
func RandomChain(g *Graph, seed int64, n int) (*Chain, *Graph, error) {
	if n < 0 {
		return nil, nil, fmt.Errorf("graphtest: negative step count %d", n)
	}
	rng := rand.New(rand.NewSource(seed))
	chain := &Chain{Seed: seed}
	cur := g.Clone()
	for i := 0; i < n; i++ {
		t, err := randomTransform(rng, cur)
		if err != nil {
			return nil, nil, fmt.Errorf("graphtest: random chain step %d: %w", i, err)
		}
		next, err := t.Apply(cur)
		if err != nil {
			return nil, nil, fmt.Errorf("graphtest: random chain step %d: %w", i, err)
		}
		chain.Steps = append(chain.Steps, t)
		cur = next
	}
	return chain, cur, nil
}

// randomTransform picks one of the three transformation kinds uniformly and
// generates legal parameters for it. If the graph has no edges, edge
// splitting is excluded.
func randomTransform(rng *rand.Rand, g *Graph) (Transform, error) {
	kinds := []Kind{KindRelabel, KindAddIsolated}
	if g.NumEdges() > 0 {
		kinds = append(kinds, KindSplitEdge)
	}
	switch kinds[rng.Intn(len(kinds))] {
	case KindRelabel:
		return randomRelabel(rng, g), nil
	case KindAddIsolated:
		return randomAddIsolated(rng, g), nil
	default:
		return randomSplitEdge(rng, g)
	}
}

// randomRelabel builds a uniformly random permutation of the vertex set
// onto a shifted label range, keeping the result distinguishable from the
// input in most cases.
func randomRelabel(rng *rand.Rand, g *Graph) Transform {
	vs := g.Vertices()
	base := rng.Intn(1 << 30)
	images := rng.Perm(len(vs))
	perm := make(map[int]int, len(vs))
	for i, v := range vs {
		perm[v] = base + images[i]
	}
	return Relabel(perm)
}

// randomAddIsolated adds 1..3 fresh vertices with labels drawn outside the
// current vertex set.
func randomAddIsolated(rng *rand.Rand, g *Graph) Transform {
	count := 1 + rng.Intn(3)
	base := rng.Intn(1 << 30)
	var added []int
	for len(added) < count {
		cand := base + rng.Intn(1<<20) + 1
		if g.HasVertex(cand) {
			continue
		}
		dup := false
		for _, v := range added {
			if v == cand {
				dup = true
				break
			}
		}
		if !dup {
			added = append(added, cand)
		}
	}
	return AddIsolated(added...)
}

// randomSplitEdge picks a uniformly random existing edge and splits it with
// a fresh midpoint label.
func randomSplitEdge(rng *rand.Rand, g *Graph) (Transform, error) {
	edges := g.Edges()
	if len(edges) == 0 {
		return Transform{}, fmt.Errorf("graphtest: cannot split an edge in an edgeless graph")
	}
	e := edges[rng.Intn(len(edges))]
	for {
		w := rng.Intn(1 << 30)
		if !g.HasVertex(w) {
			return SplitEdge(e.U, e.V, w), nil
		}
	}
}
