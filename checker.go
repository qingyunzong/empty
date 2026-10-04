package workgroup

import "sort"

// Checker is an independent verifier for wait graphs. It shares no
// state or logic with Graph: edges are handed over as plain pairs and
// legality is decided by Kahn's topological sort, so it can audit the
// wait edges a Graph accepted (or would reject).
type Checker struct{}

// Acyclic reports whether the given wait edges form a DAG. Each edge
// is a [from, to] pair meaning "from waits for to".
func (Checker) Acyclic(edges [][2]string) bool {
	_, ok := Checker{}.topo(edges)
	return ok
}

// Cycle finds a cycle among the edges, returning the node names in
// loop order, or nil if the graph is acyclic. The nodes returned are
// exactly those Kahn's algorithm cannot eliminate, i.e. nodes trapped
// on or downstream of a cycle; FindCycle then extracts one concrete
// loop from them.
func (c Checker) Cycle(edges [][2]string) []string {
	remaining, ok := c.topo(edges)
	if ok {
		return nil
	}
	// remaining holds nodes still having incoming edges after Kahn's
	// pass; walk successors within this set until a node repeats.
	adj := make(map[string][]string)
	for _, e := range edges {
		if remaining[e[0]] && remaining[e[1]] {
			adj[e[0]] = append(adj[e[0]], e[1])
		}
	}
	var start string
	for node := range remaining {
		if len(adj[node]) > 0 {
			start = node
			break
		}
	}
	seen := make(map[string]int)
	var trail []string
	for at := start; ; at = adj[at][0] {
		if idx, ok := seen[at]; ok {
			return append(trail[idx:], at)
		}
		seen[at] = len(trail)
		trail = append(trail, at)
	}
}

// topo runs Kahn's algorithm. On success it returns a topological
// ordering; on failure it returns the set of nodes that could not be
// eliminated and false.
func (Checker) topo(edges [][2]string) (map[string]bool, bool) {
	indeg := make(map[string]int)
	adj := make(map[string][]string)
	nodes := make(map[string]bool)
	for _, e := range edges {
		from, to := e[0], e[1]
		nodes[from], nodes[to] = true, true
		if _, ok := indeg[from]; !ok {
			indeg[from] = 0
		}
		adj[from] = append(adj[from], to)
		indeg[to]++
	}
	var queue []string
	for node := range nodes {
		if indeg[node] == 0 {
			queue = append(queue, node)
		}
	}
	sort.Strings(queue)
	removed := make(map[string]bool)
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		removed[cur] = true
		for _, next := range adj[cur] {
			indeg[next]--
			if indeg[next] == 0 {
				queue = append(queue, next)
			}
		}
	}
	if len(removed) == len(nodes) {
		return nil, true
	}
	remaining := make(map[string]bool)
	for node := range nodes {
		if !removed[node] {
			remaining[node] = true
		}
	}
	return remaining, false
}
