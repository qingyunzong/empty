package licchk

import "sort"

// Graph is a dependency graph: each key maps to the packages it directly
// depends on. Edges to packages absent from the map are treated as leaf
// packages (they are still reachable).
type Graph map[string][]string

// Reachable returns the sorted set of packages reachable from entry,
// including entry itself. Cycles are handled via a visited set, so the
// traversal always terminates.
func Reachable(g Graph, entry string) []string {
	seen := map[string]struct{}{entry: {}}
	stack := []string{entry}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, dep := range g[n] {
			if _, ok := seen[dep]; ok {
				continue
			}
			seen[dep] = struct{}{}
			stack = append(stack, dep)
		}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
