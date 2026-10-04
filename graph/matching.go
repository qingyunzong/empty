package graph

import "sort"

// Analysis is the result of analyzing one graph version: a maximum
// matching and a minimum vertex cover. By Kőnig's theorem both have
// the same size on bipartite graphs.
type Analysis struct {
	Version  int
	Matching []Edge
	Cover    []string
}

// Analyze computes a maximum matching (Hopcroft–Karp) and a minimum
// vertex cover (Kőnig's construction) for the current version. Results
// are cached per version. Matching edges are returned with U on the
// left and V on the right of the bipartition; both lists are sorted
// deterministically.
func (g *Graph) Analyze() Analysis {
	if g.cache != nil && g.cacheVer == g.version {
		return *g.cache
	}
	left, right := g.bipartition()
	adjL := make(map[string][]string, len(left))
	for _, u := range left {
		nbrs := make([]string, 0, len(g.adj[u]))
		for v := range g.adj[u] {
			nbrs = append(nbrs, v)
		}
		sort.Strings(nbrs)
		adjL[u] = nbrs
	}
	matchL, matchR := hopcroftKarp(left, right, adjL)
	cover := konigCover(left, right, adjL, matchL, matchR)

	matching := make([]Edge, 0, len(matchL))
	for u, v := range matchL {
		matching = append(matching, Edge{U: u, V: v})
	}
	sort.Slice(matching, func(i, j int) bool {
		if matching[i].U != matching[j].U {
			return matching[i].U < matching[j].U
		}
		return matching[i].V < matching[j].V
	})
	sort.Strings(cover)

	a := Analysis{Version: g.version, Matching: matching, Cover: cover}
	g.cache = &a
	g.cacheVer = g.version
	return a
}

// bipartition 2-colors every component deterministically (smallest ID
// first); isolated vertices are placed on the left.
func (g *Graph) bipartition() (left, right []string) {
	color := make(map[string]int, len(g.adj))
	for _, start := range g.Vertices() {
		if _, seen := color[start]; seen {
			continue
		}
		color[start] = 0
		queue := []string{start}
		for len(queue) > 0 {
			x := queue[0]
			queue = queue[1:]
			nbrs := make([]string, 0, len(g.adj[x]))
			for y := range g.adj[x] {
				nbrs = append(nbrs, y)
			}
			sort.Strings(nbrs)
			for _, y := range nbrs {
				if _, seen := color[y]; !seen {
					color[y] = color[x] ^ 1
					queue = append(queue, y)
				}
			}
		}
	}
	for _, id := range g.Vertices() {
		if color[id] == 0 {
			left = append(left, id)
		} else {
			right = append(right, id)
		}
	}
	return left, right
}

// hopcroftKarp returns the maximum matching as matchL (left→right) and
// matchR (right→left) maps.
func hopcroftKarp(left, right []string, adj map[string][]string) (map[string]string, map[string]string) {
	matchL := make(map[string]string, len(left))
	matchR := make(map[string]string, len(right))
	dist := make(map[string]int, len(left))

	bfs := func() bool {
		queue := make([]string, 0, len(left))
		for _, u := range left {
			if _, ok := matchL[u]; !ok {
				dist[u] = 0
				queue = append(queue, u)
			} else {
				dist[u] = -1
			}
		}
		found := false
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			for _, v := range adj[u] {
				w, matched := matchR[v]
				if !matched {
					found = true
					continue
				}
				if dist[w] == -1 {
					dist[w] = dist[u] + 1
					queue = append(queue, w)
				}
			}
		}
		return found
	}

	var dfs func(u string) bool
	dfs = func(u string) bool {
		for _, v := range adj[u] {
			w, matched := matchR[v]
			if !matched || (dist[w] == dist[u]+1 && dfs(w)) {
				matchL[u] = v
				matchR[v] = u
				return true
			}
		}
		dist[u] = -1
		return false
	}

	for bfs() {
		for _, u := range left {
			if _, ok := matchL[u]; !ok {
				dfs(u)
			}
		}
	}
	return matchL, matchR
}

// konigCover derives a minimum vertex cover from a maximum matching:
// let Z be the vertices reachable from unmatched left vertices via
// alternating paths; the cover is (left \ Z) ∪ (right ∩ Z).
func konigCover(left, right []string, adj map[string][]string, matchL, matchR map[string]string) []string {
	visL := make(map[string]bool, len(left))
	visR := make(map[string]bool, len(right))
	queue := make([]string, 0, len(left))
	for _, u := range left {
		if _, ok := matchL[u]; !ok {
			visL[u] = true
			queue = append(queue, u)
		}
	}
	for len(queue) > 0 {
		u := queue[0]
		queue = queue[1:]
		for _, v := range adj[u] { // non-matching edges left→right
			if matchL[u] == v || visR[v] {
				continue
			}
			visR[v] = true
			if w, ok := matchR[v]; ok && !visL[w] { // matching edges right→left
				visL[w] = true
				queue = append(queue, w)
			}
		}
	}
	cover := make([]string, 0, len(matchL))
	for _, u := range left {
		if !visL[u] {
			cover = append(cover, u)
		}
	}
	for _, v := range right {
		if visR[v] {
			cover = append(cover, v)
		}
	}
	return cover
}
