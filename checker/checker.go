// Package checker is an independent verifier for wait graphs. It does not
// share code with the workgroup package: legality (acyclicity) is decided
// with Kahn's topological sort, and a witness cycle is extracted afterwards
// with a separate depth-first search.
package checker

import (
	"fmt"
	"sort"
	"strings"
)

// Edge is a wait edge: From waits on To.
type Edge struct{ From, To string }

// CycleError reports a detected cycle; Path[0] == Path[len(Path)-1].
type CycleError struct {
	Path []string
}

func (e *CycleError) Error() string {
	return "checker: wait graph has cycle: " + strings.Join(e.Path, " -> ")
}

// Check verifies that nodes/edges form a DAG. It returns an error for
// unknown endpoints and a *CycleError with the witness cycle otherwise.
func Check(nodes []string, edges []Edge) error {
	indeg := make(map[string]int, len(nodes))
	adj := make(map[string][]string, len(nodes))
	for _, n := range nodes {
		if _, dup := indeg[n]; dup {
			return fmt.Errorf("checker: duplicate node %q", n)
		}
		indeg[n] = 0
	}
	seen := make(map[Edge]bool, len(edges))
	for _, e := range edges {
		if _, ok := indeg[e.From]; !ok {
			return fmt.Errorf("checker: edge from unknown node %q", e.From)
		}
		if _, ok := indeg[e.To]; !ok {
			return fmt.Errorf("checker: edge to unknown node %q", e.To)
		}
		if seen[e] {
			continue
		}
		seen[e] = true
		adj[e.From] = append(adj[e.From], e.To)
		indeg[e.To]++
	}

	// Kahn's algorithm: the graph is a DAG iff every node is emitted.
	queue := make([]string, 0, len(nodes))
	for n, d := range indeg {
		if d == 0 {
			queue = append(queue, n)
		}
	}
	sort.Strings(queue) // deterministic output
	emitted := 0
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		emitted++
		for _, m := range adj[n] {
			indeg[m]--
			if indeg[m] == 0 {
				queue = append(queue, m)
			}
		}
	}
	if emitted == len(nodes) {
		return nil
	}
	return &CycleError{Path: findCycle(nodes, adj)}
}

// findCycle extracts one witness cycle with a three-color DFS.
func findCycle(nodes []string, adj map[string][]string) []string {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(nodes))
	parent := make(map[string]string, len(nodes))
	sorted := append([]string(nil), nodes...)
	sort.Strings(sorted)

	var cycle []string
	var dfs func(n string) bool
	dfs = func(n string) bool {
		color[n] = gray
		for _, m := range adj[n] {
			switch color[m] {
			case gray:
				// Back edge n -> m: walk parents from n up to m.
				var walk []string
				for cur := n; cur != m; cur = parent[cur] {
					walk = append(walk, cur)
				}
				cycle = []string{m}
				for i := len(walk) - 1; i >= 0; i-- {
					cycle = append(cycle, walk[i])
				}
				cycle = append(cycle, m)
				return true
			case white:
				parent[m] = n
				if dfs(m) {
					return true
				}
			}
		}
		color[n] = black
		return false
	}
	for _, n := range sorted {
		if color[n] == white && dfs(n) {
			return cycle
		}
	}
	return nil
}
