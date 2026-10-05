package netflow

// Cut is a minimum s-t cut certificate: the set of vertices reachable
// from the source in the residual network of a maximum flow.
type Cut struct {
	// Side[v] is true when v lies on the source side of the cut.
	Side []bool
}

// Capacity returns the total capacity of edges crossing the cut from
// the source side to the sink side. For a minimum cut this equals the
// maximum flow value.
func (c Cut) Capacity(g *Graph) int {
	total := 0
	for _, e := range g.edges {
		if c.Side[e.From] && !c.Side[e.To] {
			total += e.Cap
		}
	}
	return total
}

// Crossing returns the IDs of edges crossing from the source side to
// the sink side.
func (c Cut) Crossing(g *Graph) []EdgeID {
	var ids []EdgeID
	for _, e := range g.edges {
		if c.Side[e.From] && !c.Side[e.To] {
			ids = append(ids, e.ID)
		}
	}
	return ids
}

// MaxFlow computes a maximum s-t flow with the Edmonds-Karp algorithm.
// It returns the flow value, the flow on every edge keyed by EdgeID,
// and a minimum cut certificate. The returned flow is feasible:
// 0 <= f(e) <= cap(e) and flow conservation holds at every vertex
// other than s and t.
func (g *Graph) MaxFlow(s, t int) (value int, flow map[EdgeID]int, cut Cut) {
	g.checkVertex(s)
	g.checkVertex(t)

	flow = make(map[EdgeID]int, len(g.edges))
	for id := range g.edges {
		flow[id] = 0
	}

	// Residual capacities. Forward arcs use each edge's own ID; backward
	// arcs are tracked implicitly through the flow map, so parallel
	// edges stay independent.
	residual := make(map[EdgeID]int, len(g.edges))
	for id, e := range g.edges {
		residual[id] = e.Cap
	}

	// Adjacency: for each vertex, the arcs (edge ID, direction) touching
	// it. dir=+1 means the arc leaves the vertex along the edge, dir=-1
	// means it enters the vertex (traversable when flow > 0).
	type arc struct {
		id  EdgeID
		dir int
	}
	adj := make([][]arc, g.numVertices)
	for id, e := range g.edges {
		adj[e.From] = append(adj[e.From], arc{id, +1})
		adj[e.To] = append(adj[e.To], arc{id, -1})
	}

	for {
		// BFS for a shortest augmenting path.
		prev := make([]arc, g.numVertices)
		visited := make([]bool, g.numVertices)
		visited[s] = true
		queue := []int{s}
		for len(queue) > 0 && !visited[t] {
			v := queue[0]
			queue = queue[1:]
			for _, a := range adj[v] {
				e := g.edges[a.id]
				next := e.To
				resid := residual[a.id]
				if a.dir < 0 {
					next = e.From
					resid = flow[a.id]
				}
				if resid > 0 && !visited[next] {
					visited[next] = true
					prev[next] = a
					queue = append(queue, next)
				}
			}
		}
		if !visited[t] {
			cut = Cut{Side: visited}
			return value, flow, cut
		}
		// Bottleneck along the path.
		bottleneck := -1
		for v := t; v != s; {
			a := prev[v]
			resid := residual[a.id]
			if a.dir < 0 {
				resid = flow[a.id]
			}
			if bottleneck < 0 || resid < bottleneck {
				bottleneck = resid
			}
			e := g.edges[a.id]
			if a.dir > 0 {
				v = e.From
			} else {
				v = e.To
			}
		}
		// Augment.
		for v := t; v != s; {
			a := prev[v]
			e := g.edges[a.id]
			if a.dir > 0 {
				residual[a.id] -= bottleneck
				flow[a.id] += bottleneck
				v = e.From
			} else {
				residual[a.id] += bottleneck
				flow[a.id] -= bottleneck
				v = e.To
			}
		}
		value += bottleneck
	}
}
