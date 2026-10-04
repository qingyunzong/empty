// Package verify independently checks matchings and vertex covers
// produced by the graph package, and provides brute-force reference
// implementations for small graphs. It shares no algorithm code with
// the graph package.
package verify

import (
	"fmt"
	"math/bits"
)

// Edge is an undirected edge between left vertex L and right vertex R.
type Edge struct {
	L string
	R string
}

// CheckMatching verifies that every matched edge exists in edges and
// that no two matched edges share an endpoint.
func CheckMatching(edges []Edge, matching []Edge) error {
	edgeSet := make(map[Edge]struct{}, len(edges))
	for _, e := range edges {
		edgeSet[e] = struct{}{}
	}
	usedL := make(map[string]struct{})
	usedR := make(map[string]struct{})
	for _, e := range matching {
		if _, ok := edgeSet[e]; !ok {
			return fmt.Errorf("matched edge (%q, %q) not present in graph", e.L, e.R)
		}
		if _, ok := usedL[e.L]; ok {
			return fmt.Errorf("left vertex %q matched more than once", e.L)
		}
		if _, ok := usedR[e.R]; ok {
			return fmt.Errorf("right vertex %q matched more than once", e.R)
		}
		usedL[e.L] = struct{}{}
		usedR[e.R] = struct{}{}
	}
	return nil
}

// CheckCover verifies that every edge has at least one endpoint in cover.
func CheckCover(edges []Edge, cover []string) error {
	in := make(map[string]struct{}, len(cover))
	for _, v := range cover {
		in[v] = struct{}{}
	}
	for _, e := range edges {
		_, lok := in[e.L]
		_, rok := in[e.R]
		if !lok && !rok {
			return fmt.Errorf("edge (%q, %q) is not covered", e.L, e.R)
		}
	}
	return nil
}

// CheckEqualSizes verifies that the matching and the cover have the
// same number of elements.
func CheckEqualSizes(matching []Edge, cover []string) error {
	if len(matching) != len(cover) {
		return fmt.Errorf("matching size %d != cover size %d", len(matching), len(cover))
	}
	return nil
}

// MinVertexCover brute-forces a minimum vertex cover by enumerating all
// vertex subsets. It is only suitable for small graphs and refuses more
// than 24 vertices.
func MinVertexCover(vertices []string, edges []Edge) (cover []string, size int, err error) {
	n := len(vertices)
	if n > 24 {
		return nil, 0, fmt.Errorf("brute force limited to 24 vertices, got %d", n)
	}
	idx := make(map[string]int, n)
	for i, v := range vertices {
		idx[v] = i
	}
	bestSize := n + 1
	for mask := 0; mask < 1<<uint(n); mask++ {
		s := bits.OnesCount(uint(mask))
		if s >= bestSize {
			continue
		}
		ok := true
		for _, e := range edges {
			li, lok := idx[e.L]
			ri, rok := idx[e.R]
			if (!lok || mask&(1<<uint(li)) == 0) && (!rok || mask&(1<<uint(ri)) == 0) {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		bestSize = s
		cover = cover[:0]
		for i, v := range vertices {
			if mask&(1<<uint(i)) != 0 {
				cover = append(cover, v)
			}
		}
	}
	return cover, bestSize, nil
}

// MaxMatching brute-forces the maximum matching size by enumerating
// edge subsets. It is only suitable for small graphs.
func MaxMatching(edges []Edge) int {
	best := 0
	usedL := make(map[string]bool)
	usedR := make(map[string]bool)
	var rec func(i, count int)
	rec = func(i, count int) {
		if count+len(edges)-i <= best {
			return
		}
		if i == len(edges) {
			best = count
			return
		}
		e := edges[i]
		if !usedL[e.L] && !usedR[e.R] {
			usedL[e.L] = true
			usedR[e.R] = true
			rec(i+1, count+1)
			usedL[e.L] = false
			usedR[e.R] = false
		}
		rec(i+1, count)
	}
	rec(0, 0)
	return best
}
