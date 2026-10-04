package transfer

// BruteForce 用逐边流量枚举求最低成本方案，作为 Solve 的对照实现。
//
// 对每条边枚举 f ∈ {0} ∪ [Loss, Capacity]，叶子处校验全部节点守恒约束。
// 剪枝（安全）：处理到第 k 条边时，若某节点已确定的净流出超过
// “库存 + 已确定流入 + 剩余边最大可能流入”，则该分支不可能可行。
func BruteForce(n Network) (Plan, error) {
	if err := Validate(n); err != nil {
		return Plan{}, err
	}
	m := len(n.Edges)
	// remIn[k][u]：第 k 条及之后的边能为 u 提供的最大流入上界。
	remIn := make([][]int, m+1)
	remIn[m] = make([]int, n.Nodes)
	for k := m - 1; k >= 0; k-- {
		remIn[k] = make([]int, n.Nodes)
		copy(remIn[k], remIn[k+1])
		if e := n.Edges[k]; e.Capacity >= e.Loss {
			remIn[k][e.To] += e.Capacity - e.Loss
		}
	}

	out := make([]int, n.Nodes) // 已确定的净流出（含损耗）
	in := make([]int, n.Nodes)  // 已确定的净流入
	flows := make([]int, m)
	bestFlows := make([]int, m)
	bestCost := -1

	var dfs func(k, cost int)
	dfs = func(k, cost int) {
		if bestCost >= 0 && cost >= bestCost {
			return
		}
		if k == m {
			for u := 0; u < n.Nodes; u++ {
				if n.Supply[u]+in[u] < n.Demand[u]+out[u] {
					return
				}
			}
			bestCost = cost
			copy(bestFlows, flows)
			return
		}
		e := n.Edges[k]
		// 当前分支下 e 允许的最大流量：受容量与起点可承担净流出双重限制。
		maxF := e.Capacity
		if room := n.Supply[e.From] + in[e.From] + remIn[k+1][e.From] - out[e.From]; room < maxF {
			maxF = room
		}
		try := func(f int) {
			flows[k] = f
			out[e.From] += f
			if f > 0 {
				in[e.To] += f - e.Loss
			}
			dfs(k+1, cost+e.Cost*f)
			out[e.From] -= f
			if f > 0 {
				in[e.To] -= f - e.Loss
			}
		}
		try(0)
		if e.Loss <= maxF {
			for f := e.Loss; f <= maxF; f++ {
				try(f)
			}
		}
	}
	dfs(0, 0)

	if bestCost < 0 {
		return Plan{Feasible: false, Flows: make([]int, m)}, nil
	}
	return Plan{Feasible: true, Cost: bestCost, Flows: bestFlows}, nil
}
