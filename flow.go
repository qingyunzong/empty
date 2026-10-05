package main

// Min-cost max-flow over a small directed graph with non-negative
// edge costs, using successive shortest augmenting paths (SPFA).
// The instance sizes here (<= ~60 nodes, <= ~500 edges, flow <= 160)
// make this comfortably fast.

type mcfEdge struct {
	to, rev  int
	cap      int
	cost     int
	flowFrom int // original edge owner, for plan extraction
}

type mcfGraph struct {
	n     int
	edges [][]mcfEdge
}

func newMCFGraph(n int) *mcfGraph {
	return &mcfGraph{n: n, edges: make([][]mcfEdge, n)}
}

// addEdge adds a forward edge u->v and its residual backward edge.
// tag marks forward edges so the solver can recover the flow on them.
func (g *mcfGraph) addEdge(u, v, cap, cost, tag int) {
	g.edges[u] = append(g.edges[u], mcfEdge{to: v, rev: len(g.edges[v]), cap: cap, cost: cost, flowFrom: tag})
	g.edges[v] = append(g.edges[v], mcfEdge{to: u, rev: len(g.edges[u]) - 1, cap: 0, cost: -cost, flowFrom: -1})
}

// minCostFlow pushes up to maxFlow units from s to t at minimum total
// cost. It returns (flow, cost); flow < maxFlow means the network is
// saturated before reaching maxFlow.
func (g *mcfGraph) minCostFlow(s, t, maxFlow int) (int, int) {
	const inf = int(^uint(0) >> 2)
	flow, cost := 0, 0
	dist := make([]int, g.n)
	prevV := make([]int, g.n)
	prevE := make([]int, g.n)
	inQ := make([]bool, g.n)
	for flow < maxFlow {
		for i := range dist {
			dist[i] = inf
		}
		dist[s] = 0
		queue := []int{s}
		inQ[s] = true
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			inQ[u] = false
			for ei, e := range g.edges[u] {
				if e.cap > 0 && dist[e.to] > dist[u]+e.cost {
					dist[e.to] = dist[u] + e.cost
					prevV[e.to] = u
					prevE[e.to] = ei
					if !inQ[e.to] {
						queue = append(queue, e.to)
						inQ[e.to] = true
					}
				}
			}
		}
		if dist[t] == inf {
			break
		}
		d := maxFlow - flow
		for v := t; v != s; v = prevV[v] {
			if c := g.edges[prevV[v]][prevE[v]].cap; c < d {
				d = c
			}
		}
		for v := t; v != s; v = prevV[v] {
			e := &g.edges[prevV[v]][prevE[v]]
			e.cap -= d
			g.edges[v][e.rev].cap += d
		}
		flow += d
		cost += d * dist[t]
	}
	return flow, cost
}
