package licenseselect

import "sort"

// Package is a node in the dependency graph.
type Package struct {
	Name string
	// License is the raw license expression, e.g. "(MIT OR Apache-2.0)".
	License string
	// Deps lists names of direct dependencies.
	Deps []string
}

// Graph is a dependency graph keyed by package name.
type Graph struct {
	Pkgs map[string]Package
}

// Reachable returns the names of all packages reachable from entry,
// including entry itself. Cycles are handled via a visited set, so the
// traversal always terminates and each package is reported once.
// Unknown dependency names are ignored.
func (g *Graph) Reachable(entry string) []string {
	visited := map[string]bool{}
	queue := []string{entry}
	visited[entry] = true
	var out []string
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		pkg, ok := g.Pkgs[name]
		if !ok {
			continue
		}
		out = append(out, name)
		for _, dep := range pkg.Deps {
			if !visited[dep] {
				visited[dep] = true
				queue = append(queue, dep)
			}
		}
	}
	sort.Strings(out)
	return out
}
