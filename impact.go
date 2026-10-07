package impact

// Result describes how a single test is affected by the change set.
type Result struct {
	// Test is the test file ID.
	Test string
	// Affected reports whether any changed or deleted file is reachable
	// from the test through the merged dependency graph.
	Affected bool
	// Path is the shortest dependency path from the test to a changed
	// or deleted file, inclusive of both endpoints. Among several
	// shortest paths the lexicographically smallest node-ID sequence
	// wins. Path is nil when the test is unaffected.
	Path []string
}

// Analyze computes, for every test, the shortest dependency path to the
// change set. The analysis runs on the merge of the old and new graphs
// so that nodes deleted in the new graph still contribute their
// old-graph influence. Results are returned in the order of tests.
func Analyze(oldGraph, newGraph *Graph, cs *ChangeSet, tests []string) []Result {
	merged := Merge(oldGraph, newGraph)
	targets := cs.Targets()
	results := make([]Result, 0, len(tests))
	for _, test := range tests {
		path := shortestPath(merged, test, targets)
		results = append(results, Result{
			Test:     test,
			Affected: path != nil,
			Path:     path,
		})
	}
	return results
}

// shortestPath runs a per-test breadth-first search from start to the
// nearest target node. All edges have unit weight, so BFS levels give
// shortest paths; within a level only the lexicographically smallest
// path to each node is kept, which yields the lexicographically
// smallest node-ID sequence among all shortest paths. A visited set
// makes the search cycle-safe: every node is expanded at most once, at
// its shallowest level.
func shortestPath(g *Graph, start string, targets map[string]bool) []string {
	if targets[start] {
		return []string{start}
	}
	visited := map[string]bool{start: true}
	// frontier maps a node to the lexicographically smallest path that
	// reaches it at the current BFS level.
	frontier := map[string][]string{start: {start}}
	for len(frontier) > 0 {
		next := map[string][]string{}
		for node, path := range frontier {
			for _, dep := range g.Edges[node] {
				if visited[dep] {
					continue
				}
				candidate := append(append([]string{}, path...), dep)
				if best, ok := next[dep]; !ok || lessPath(candidate, best) {
					next[dep] = candidate
				}
			}
		}
		var best []string
		for node, path := range next {
			visited[node] = true
			if targets[node] && (best == nil || lessPath(path, best)) {
				best = path
			}
		}
		if best != nil {
			return best
		}
		frontier = next
	}
	return nil
}

// lessPath reports whether a is lexicographically smaller than b as a
// sequence of node IDs.
func lessPath(a, b []string) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}
