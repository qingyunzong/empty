package route

// Enumerate finds the optimal route by exhaustive simple-path enumeration
// (no repeated nodes). It is the ground-truth cross-check for the other
// solvers. Returns the best evaluated path and whether one exists.
func (n *Network) Enumerate() (EvalResult, bool) {
	start, _ := n.NodeIndex(n.Start)
	end, _ := n.NodeIndex(n.End)
	var best EvalResult
	found := false
	visited := make([]bool, n.NumNodes())
	visited[start] = true
	path := []int{start}
	var dfs func(v int)
	dfs = func(v int) {
		if v == end {
			if r := n.EvalPath(append([]int(nil), path...)); r.OK {
				if !found || better(r.Paid, r.Time, best.Paid, best.Time) {
					best, found = r, true
				}
			}
			return
		}
		for _, ei := range n.OutEdges(v) {
			_, to := n.EdgeEndpoints(ei)
			if visited[to] {
				continue
			}
			visited[to] = true
			path = append(path, to)
			dfs(to)
			path = path[:len(path)-1]
			visited[to] = false
		}
	}
	dfs(start)
	return best, found
}
