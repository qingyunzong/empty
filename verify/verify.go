// Package verify independently checks analyses produced by the graph
// package: it validates that a matching is a real matching, that a
// vertex cover really covers every edge, that both have equal size,
// and—on small graphs—that the cover is truly minimum by exhaustive
// subset enumeration.
package verify

import (
	"errors"
	"fmt"

	"graphlib/graph"
)

// bruteForceLimit caps the vertex count for exhaustive enumeration.
const bruteForceLimit = 24

// CheckMatching verifies that m is a valid matching of g: every listed
// edge exists and no vertex is incident to more than one matched edge.
func CheckMatching(g *graph.Graph, m []graph.Edge) error {
	used := make(map[string]string, 2*len(m))
	for _, e := range m {
		if !g.Has(e.U, e.V) {
			return fmt.Errorf("verify: matched edge {%s,%s} not in graph", e.U, e.V)
		}
		for _, x := range [2]string{e.U, e.V} {
			if prev, dup := used[x]; dup {
				return fmt.Errorf("verify: vertex %s shared by matched edges {%s} and {%s,%s}", x, prev, e.U, e.V)
			}
			used[x] = e.U + "," + e.V
		}
	}
	return nil
}

// CheckCover verifies that cover is a vertex cover of g: every edge has
// at least one endpoint in cover. Unknown or duplicated IDs are
// rejected.
func CheckCover(g *graph.Graph, cover []string) error {
	inCover := make(map[string]bool, len(cover))
	known := make(map[string]bool)
	for _, id := range g.Vertices() {
		known[id] = true
	}
	for _, id := range cover {
		if !known[id] {
			return fmt.Errorf("verify: cover contains unknown vertex %s", id)
		}
		if inCover[id] {
			return fmt.Errorf("verify: cover lists vertex %s twice", id)
		}
		inCover[id] = true
	}
	for _, e := range g.Edges() {
		if !inCover[e.U] && !inCover[e.V] {
			return fmt.Errorf("verify: edge {%s,%s} uncovered", e.U, e.V)
		}
	}
	return nil
}

// CheckEqualSize verifies that the matching and the cover have the
// same number of elements.
func CheckEqualSize(m []graph.Edge, cover []string) error {
	if len(m) != len(cover) {
		return fmt.Errorf("verify: |matching|=%d != |cover|=%d", len(m), len(cover))
	}
	return nil
}

// MinCoverSize enumerates all vertex subsets to find the exact minimum
// vertex cover size. It reports false when the graph has more than
// bruteForceLimit vertices.
func MinCoverSize(g *graph.Graph) (int, bool) {
	vs := g.Vertices()
	n := len(vs)
	if n > bruteForceLimit {
		return 0, false
	}
	edges := g.Edges()
	best := n + 1
	// Enumerate subsets grouped by popcount so we can stop early.
	for size := 0; size <= n; size++ {
		if found := hasCoverOfSize(vs, edges, size); found {
			best = size
			break
		}
	}
	return best, true
}

func hasCoverOfSize(vs []string, edges []graph.Edge, size int) bool {
	n := len(vs)
	idx := make([]int, size)
	var cover func(start, depth int) bool
	cover = func(start, depth int) bool {
		if depth == size {
			chosen := make(map[string]bool, size)
			for _, i := range idx {
				chosen[vs[i]] = true
			}
			for _, e := range edges {
				if !chosen[e.U] && !chosen[e.V] {
					return false
				}
			}
			return true
		}
		for i := start; i <= n-(size-depth); i++ {
			idx[depth] = i
			if cover(i+1, depth+1) {
				return true
			}
		}
		return false
	}
	return cover(0, 0)
}

// Analysis runs all independent checks on one analysis result. For
// graphs within the brute-force limit it also confirms that the cover
// is minimum; together with |matching| == |cover| this proves the
// matching is maximum, since no matching can exceed any cover.
func Analysis(g *graph.Graph, a graph.Analysis) error {
	if a.Version != g.Version() {
		return fmt.Errorf("verify: analysis version %d != graph version %d", a.Version, g.Version())
	}
	if err := CheckMatching(g, a.Matching); err != nil {
		return err
	}
	if err := CheckCover(g, a.Cover); err != nil {
		return err
	}
	if err := CheckEqualSize(a.Matching, a.Cover); err != nil {
		return err
	}
	if min, ok := MinCoverSize(g); ok && min != len(a.Cover) {
		return fmt.Errorf("verify: cover size %d is not minimum (brute force: %d)", len(a.Cover), min)
	}
	return nil
}

// ErrTooLarge is returned by MustMinCoverSize for graphs beyond the
// brute-force limit.
var ErrTooLarge = errors.New("verify: graph too large for brute force")
