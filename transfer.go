// Package transfer 是一个调拨规划库：在带固定损耗的运输网络上求满足需求的最低成本方案。
//
// 模型约定：
//   - 网络不超过 8 个节点、10 条边，每点库存不超过 20。
//   - 每条边有整数容量 Capacity、单位成本 Cost、固定整数损耗 Loss。
//   - 边流量 f 为整数，取值 f ∈ {0} ∪ [Loss, Capacity]；f > 0 即“启用”，
//     损耗先扣：从起点发出 f，到达终点 f - Loss。
//   - 货物守恒：每个节点 库存 + 流入 >= 需求 + 流出（库存是可用上限，需求必须被满足，
//     货物只经损耗减少，不会凭空产生）。
//   - 目标：最小化总成本 Σ Cost_e * f_e。
package transfer

import "errors"

// 规模限制。
const (
	MaxNodes     = 8
	MaxEdges     = 10
	MaxInventory = 20
)

// Edge 表示一条运输边。
type Edge struct {
	From     int // 起点
	To       int // 终点
	Capacity int // 整数容量
	Cost     int // 单位流量成本
	Loss     int // 启用时固定整数损耗（先扣）
}

// Network 表示一个调拨网络。
type Network struct {
	Nodes  int    // 节点数，编号 0..Nodes-1
	Supply []int  // 每点库存（可用上限）
	Demand []int  // 每点需求（必须满足）
	Edges  []Edge // 运输边
}

// Plan 表示一个调拨方案。
type Plan struct {
	Feasible bool  // 是否存在满足需求的方案
	Cost     int   // 总成本（不可行时为 0）
	Flows    []int // 每边实际流量（与 Network.Edges 对齐）
}

// Validate 校验网络规模与参数合法性。
func Validate(n Network) error {
	if n.Nodes < 1 || n.Nodes > MaxNodes {
		return errors.New("transfer: 节点数须在 1..8 之间")
	}
	if len(n.Supply) != n.Nodes || len(n.Demand) != n.Nodes {
		return errors.New("transfer: Supply/Demand 长度须等于节点数")
	}
	if len(n.Edges) > MaxEdges {
		return errors.New("transfer: 边数须不超过 10")
	}
	for i := 0; i < n.Nodes; i++ {
		if n.Supply[i] < 0 || n.Supply[i] > MaxInventory {
			return errors.New("transfer: 每点库存须在 0..20 之间")
		}
		if n.Demand[i] < 0 {
			return errors.New("transfer: 需求不能为负")
		}
	}
	for _, e := range n.Edges {
		if e.From < 0 || e.From >= n.Nodes || e.To < 0 || e.To >= n.Nodes {
			return errors.New("transfer: 边端点越界")
		}
		if e.From == e.To {
			return errors.New("transfer: 不允许自环")
		}
		if e.Capacity < 0 || e.Cost < 0 || e.Loss < 0 {
			return errors.New("transfer: 容量/成本/损耗不能为负")
		}
	}
	return nil
}

// Solve 求满足需求的最低成本方案。
//
// 方法：枚举启用边子集（最多 2^10）。固定子集 S 后，令 g_e = f_e - Loss_e >= 0，
// 问题化为标准最小费用流：边容量 Capacity-Loss、单位成本 Cost，
// 节点 u 的净可外调量 b_u = Supply_u - Demand_u - Σ_{e∈S, e 出 u} Loss_e。
// 用超级源汇判定可行性并求最小费用，取所有子集中的最优。
func Solve(n Network) (Plan, error) {
	if err := Validate(n); err != nil {
		return Plan{}, err
	}
	m := len(n.Edges)
	best := Plan{Feasible: false, Flows: make([]int, m)}
	bestCost := -1
	for mask := 0; mask < (1 << m); mask++ {
		cost, flows, ok := solveSubset(n, mask)
		if !ok {
			continue
		}
		if bestCost < 0 || cost < bestCost {
			bestCost = cost
			best = Plan{Feasible: true, Cost: cost, Flows: flows}
		}
	}
	return best, nil
}

// solveSubset 在“启用边集合为 mask”的前提下求最小费用；不可行返回 ok=false。
func solveSubset(n Network, mask int) (int, []int, bool) {
	m := len(n.Edges)
	// 节点平衡 b_u = 库存 - 需求 - 启用出边损耗之和。
	b := make([]int, n.Nodes)
	for u := 0; u < n.Nodes; u++ {
		b[u] = n.Supply[u] - n.Demand[u]
	}
	for i, e := range n.Edges {
		if mask&(1<<i) == 0 {
			continue
		}
		if e.Loss > e.Capacity {
			return 0, nil, false // 该边永远不可用，子集非法
		}
		b[e.From] -= e.Loss
	}
	total := 0
	for u := 0; u < n.Nodes; u++ {
		total += b[u]
	}
	if total < 0 {
		return 0, nil, false
	}

	// 建图：超级源 S=Nodes，超级汇 T=Nodes+1。
	S, T := n.Nodes, n.Nodes+1
	mf := newMinCostFlow(n.Nodes + 2)
	arcIdx := make([][2]int, m) // 启用边在残量网络中的位置
	for i, e := range n.Edges {
		if mask&(1<<i) == 0 {
			arcIdx[i] = [2]int{-1, -1}
			continue
		}
		arcIdx[i] = [2]int{e.From, mf.addEdge(e.From, e.To, e.Capacity-e.Loss, e.Cost)}
	}
	need := 0
	for u := 0; u < n.Nodes; u++ {
		if b[u] > 0 {
			mf.addEdge(S, u, b[u], 0)
		} else if b[u] < 0 {
			mf.addEdge(u, T, -b[u], 0)
			need += -b[u]
		}
	}
	flow, _ := mf.minCostMaxFlow(S, T)
	if flow != need {
		return 0, nil, false
	}

	// 还原流量 f = g + Loss 并直接核算成本。
	flows := make([]int, m)
	cost := 0
	for i, e := range n.Edges {
		if arcIdx[i][0] < 0 {
			continue
		}
		g := mf.used(arcIdx[i][0], arcIdx[i][1])
		flows[i] = g + e.Loss
		cost += e.Cost * flows[i]
	}
	return cost, flows, true
}
