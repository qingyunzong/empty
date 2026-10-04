package graph

import "sort"

// Result is the analysis of one graph version: a maximum matching and a
// minimum vertex cover. By Konig's theorem both have the same size.
type Result struct {
	Version  int
	Matching []Edge
	Cover    []string
}

// Analyze computes a maximum matching (Hopcroft-Karp) of the current
// version and derives a minimum vertex cover of the same size via
// Konig's construction.
func (g *Graph) Analyze() Result {
	matchL, matchR := hopcroftKarp(g.left, g.adj)
	matching := make([]Edge, 0, len(matchL))
	for l, r := range matchL {
		matching = append(matching, Edge{L: l, R: r})
	}
	sort.Slice(matching, func(i, j int) bool {
		if matching[i].L != matching[j].L {
			return matching[i].L < matching[j].L
		}
		return matching[i].R < matching[j].R
	})
	return Result{
		Version:  g.version,
		Matching: matching,
		Cover:    konigCover(g, matchL, matchR),
	}
}

// hopcroftKarp returns the maximum matching as left->right and
// right->left maps.
func hopcroftKarp(left map[string]struct{}, adj map[string]map[string]struct{}) (map[string]string, map[string]string) {
	matchL := make(map[string]string)
	matchR := make(map[string]string)
	dist := make(map[string]int)

	bfs := func() bool {
		var queue []string
		for l := range left {
			if _, ok := matchL[l]; !ok {
				dist[l] = 0
				queue = append(queue, l)
			} else {
				dist[l] = -1
			}
		}
		found := false
		for len(queue) > 0 {
			l := queue[0]
			queue = queue[1:]
			for r := range adj[l] {
				if m, ok := matchR[r]; ok {
					if dist[m] == -1 {
						dist[m] = dist[l] + 1
						queue = append(queue, m)
					}
				} else {
					found = true
				}
			}
		}
		return found
	}

	var dfs func(l string) bool
	dfs = func(l string) bool {
		for r := range adj[l] {
			m, ok := matchR[r]
			if !ok || (dist[m] == dist[l]+1 && dfs(m)) {
				matchL[l] = r
				matchR[r] = l
				return true
			}
		}
		dist[l] = -1
		return false
	}

	for bfs() {
		for l := range left {
			if _, ok := matchL[l]; !ok {
				dfs(l)
			}
		}
	}
	return matchL, matchR
}

// konigCover builds a minimum vertex cover from a maximum matching:
// let Z be the vertices reachable from unmatched left vertices via
// alternating paths (non-matching edges left->right, matching edges
// right->left); the cover is (Left \ Z) u (Right n Z).
func konigCover(g *Graph, matchL, matchR map[string]string) []string {
	visitedL := make(map[string]bool)
	visitedR := make(map[string]bool)
	var queue []string
	for l := range g.left {
		if _, ok := matchL[l]; !ok {
			visitedL[l] = true
			queue = append(queue, l)
		}
	}
	for len(queue) > 0 {
		l := queue[0]
		queue = queue[1:]
		for r := range g.adj[l] {
			if m, ok := matchL[l]; ok && m == r {
				continue // traverse only non-matching edges left->right
			}
			if visitedR[r] {
				continue
			}
			visitedR[r] = true
			if m, ok := matchR[r]; ok && !visitedL[m] {
				visitedL[m] = true
				queue = append(queue, m)
			}
		}
	}
	var cover []string
	for l := range g.left {
		if !visitedL[l] {
			cover = append(cover, l)
		}
	}
	for r := range g.right {
		if visitedR[r] {
			cover = append(cover, r)
		}
	}
	sort.Strings(cover)
	return cover
}
