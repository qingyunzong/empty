package impact

// referenceShortestPath is an independent, deliberately simple
// implementation used to cross-verify shortestPath in tests. It
// exhaustively enumerates every simple path from start (bounded by the
// node count, hence cycle-safe) and returns the shortest one, breaking
// ties by the lexicographically smallest node-ID sequence.
func referenceShortestPath(g *Graph, start string, targets map[string]bool) []string {
	maxDepth := len(g.Nodes())
	var best []string
	onPath := map[string]bool{start: true}
	var walk func(path []string)
	walk = func(path []string) {
		node := path[len(path)-1]
		if targets[node] {
			if best == nil || len(path) < len(best) ||
				(len(path) == len(best) && lessPath(path, best)) {
				best = append([]string{}, path...)
			}
			return
		}
		if len(path) > maxDepth {
			return
		}
		if best != nil && len(path) >= len(best) {
			return
		}
		for _, dep := range g.Edges[node] {
			if onPath[dep] {
				continue
			}
			onPath[dep] = true
			walk(append(path, dep))
			delete(onPath, dep)
		}
	}
	walk([]string{start})
	return best
}
