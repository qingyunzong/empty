package transfer

// 最小费用最大流（SPFA 逐路增广）。节点与流量规模都很小，无需势函数优化。
type mcmfEdge struct {
	to, rev, cap, cost int
}

type minCostFlow struct {
	g [][]mcmfEdge
}

func newMinCostFlow(n int) *minCostFlow {
	return &minCostFlow{g: make([][]mcmfEdge, n)}
}

// addEdge 加入一条有向边，返回其在邻接表中的下标。
func (mf *minCostFlow) addEdge(from, to, cap, cost int) int {
	fwd := mcmfEdge{to: to, rev: len(mf.g[to]), cap: cap, cost: cost}
	rev := mcmfEdge{to: from, rev: len(mf.g[from]), cap: 0, cost: -cost}
	mf.g[from] = append(mf.g[from], fwd)
	mf.g[to] = append(mf.g[to], rev)
	return len(mf.g[from]) - 1
}

// used 返回边上已使用的流量。
func (mf *minCostFlow) used(from, idx int) int {
	e := mf.g[from][idx]
	return mf.g[e.to][e.rev].cap
}

// minCostMaxFlow 返回最大流量及对应最小费用（成本非负，故最大流即最小费用可行流）。
func (mf *minCostFlow) minCostMaxFlow(s, t int) (int, int) {
	n := len(mf.g)
	totalFlow, totalCost := 0, 0
	for {
		dist := make([]int, n)
		prevV := make([]int, n)
		prevE := make([]int, n)
		inQ := make([]bool, n)
		const inf = int(^uint(0) >> 1)
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
			for i, e := range mf.g[u] {
				if e.cap > 0 && dist[e.to] > dist[u]+e.cost {
					dist[e.to] = dist[u] + e.cost
					prevV[e.to] = u
					prevE[e.to] = i
					if !inQ[e.to] {
						inQ[e.to] = true
						queue = append(queue, e.to)
					}
				}
			}
		}
		if dist[t] == inf {
			break
		}
		d := int(^uint(0) >> 1)
		for v := t; v != s; v = prevV[v] {
			if c := mf.g[prevV[v]][prevE[v]].cap; c < d {
				d = c
			}
		}
		for v := t; v != s; v = prevV[v] {
			e := &mf.g[prevV[v]][prevE[v]]
			e.cap -= d
			mf.g[v][e.rev].cap += d
		}
		totalFlow += d
		totalCost += d * dist[t]
	}
	return totalFlow, totalCost
}
