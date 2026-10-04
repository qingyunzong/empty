package transfer

import (
	"math/rand"
	"testing"
)

// checkPlan 独立校验方案是否满足模型约束且成本核算正确。
func checkPlan(t *testing.T, n Network, p Plan) {
	t.Helper()
	if !p.Feasible {
		t.Fatal("方案不可行")
	}
	if len(p.Flows) != len(n.Edges) {
		t.Fatalf("Flows 长度 %d，期望 %d", len(p.Flows), len(n.Edges))
	}
	out := make([]int, n.Nodes)
	in := make([]int, n.Nodes)
	cost := 0
	for i, e := range n.Edges {
		f := p.Flows[i]
		if f < 0 || f > e.Capacity || (f > 0 && f < e.Loss) {
			t.Fatalf("边 %d 流量 %d 非法（容量 %d，损耗 %d）", i, f, e.Capacity, e.Loss)
		}
		out[e.From] += f
		if f > 0 {
			in[e.To] += f - e.Loss
		}
		cost += e.Cost * f
	}
	for u := 0; u < n.Nodes; u++ {
		if n.Supply[u]+in[u] < n.Demand[u]+out[u] {
			t.Fatalf("节点 %d 不守恒：库存 %d + 流入 %d < 需求 %d + 流出 %d",
				u, n.Supply[u], in[u], n.Demand[u], out[u])
		}
	}
	if cost != p.Cost {
		t.Fatalf("成本核算不符：实算 %d，报告 %d", cost, p.Cost)
	}
}

// TestFixedExample 手算样例：3 点 3 边，最优 f=[9,7,0]，成本 39。
func TestFixedExample(t *testing.T) {
	n := Network{
		Nodes:  3,
		Supply: []int{20, 0, 0},
		Demand: []int{0, 8, 5},
		Edges: []Edge{
			{From: 0, To: 1, Capacity: 10, Cost: 2, Loss: 1},
			{From: 0, To: 2, Capacity: 10, Cost: 3, Loss: 2},
			{From: 1, To: 2, Capacity: 10, Cost: 1, Loss: 1},
		},
	}
	for name, solve := range map[string]func(Network) (Plan, error){"Solve": Solve, "BruteForce": BruteForce} {
		p, err := solve(n)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		checkPlan(t, n, p)
		if p.Cost != 39 {
			t.Fatalf("%s: 成本 %d，期望 39（flows=%v）", name, p.Cost, p.Flows)
		}
	}
}

// TestInfeasible 损耗吞掉全部可用库存时不可行。
func TestInfeasible(t *testing.T) {
	n := Network{
		Nodes:  2,
		Supply: []int{5, 0},
		Demand: []int{0, 5},
		Edges:  []Edge{{From: 0, To: 1, Capacity: 8, Cost: 1, Loss: 3}},
	}
	for name, solve := range map[string]func(Network) (Plan, error){"Solve": Solve, "BruteForce": BruteForce} {
		p, err := solve(n)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if p.Feasible {
			t.Fatalf("%s: 应不可行，得到 %v", name, p)
		}
	}
}

// TestZeroDemand 无需求时空方案最优（成本 0）。
func TestZeroDemand(t *testing.T) {
	n := Network{
		Nodes:  2,
		Supply: []int{20, 0},
		Demand: []int{0, 0},
		Edges:  []Edge{{From: 0, To: 1, Capacity: 8, Cost: 1, Loss: 3}},
	}
	p, err := Solve(n)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Feasible || p.Cost != 0 {
		t.Fatalf("期望可行且成本 0，得到 %+v", p)
	}
}

// TestTransshipment 中转链路：0→1→2，损耗逐段扣。
// 需求 2 点收 10：f01 = 12（到 11），f12 = 11（到 10），成本 12*1 + 11*1 = 23。
func TestTransshipment(t *testing.T) {
	n := Network{
		Nodes:  3,
		Supply: []int{20, 0, 0},
		Demand: []int{0, 0, 10},
		Edges: []Edge{
			{From: 0, To: 1, Capacity: 15, Cost: 1, Loss: 1},
			{From: 1, To: 2, Capacity: 15, Cost: 1, Loss: 1},
		},
	}
	p, err := Solve(n)
	if err != nil {
		t.Fatal(err)
	}
	checkPlan(t, n, p)
	if p.Cost != 23 {
		t.Fatalf("成本 %d，期望 23（flows=%v）", p.Cost, p.Flows)
	}
}

// TestRandomAgainstBruteForce 随机网络上对照 Solve 与逐边枚举。
func TestRandomAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 400; trial++ {
		nodes := 2 + rng.Intn(7) // 2..8
		m := rng.Intn(11)        // 0..10
		n := Network{Nodes: nodes, Supply: make([]int, nodes), Demand: make([]int, nodes)}
		for u := 0; u < nodes; u++ {
			n.Supply[u] = rng.Intn(21) // 0..20
			n.Demand[u] = rng.Intn(9)  // 0..8
		}
		for i := 0; i < m; i++ {
			from, to := rng.Intn(nodes), rng.Intn(nodes)
			if from == to {
				continue
			}
			n.Edges = append(n.Edges, Edge{
				From:     from,
				To:       to,
				Capacity: rng.Intn(13), // 0..12
				Cost:     rng.Intn(6),  // 0..5
				Loss:     rng.Intn(5),  // 0..4
			})
		}
		got, err := Solve(n)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		want, err := BruteForce(n)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if got.Feasible != want.Feasible {
			t.Fatalf("trial %d: 可行性不一致 Solve=%v BruteForce=%v\n网络=%+v", trial, got.Feasible, want.Feasible, n)
		}
		if !got.Feasible {
			continue
		}
		if got.Cost != want.Cost {
			t.Fatalf("trial %d: 成本不一致 Solve=%d BruteForce=%d\n网络=%+v\nSolve flows=%v\nBrute flows=%v",
				trial, got.Cost, want.Cost, n, got.Flows, want.Flows)
		}
		checkPlan(t, n, got)
		checkPlan(t, n, want)
	}
}

// TestValidateLimits 规模与参数校验。
func TestValidateLimits(t *testing.T) {
	base := Network{Nodes: 2, Supply: []int{1, 0}, Demand: []int{0, 1}}
	bad := []Network{
		{Nodes: 9, Supply: make([]int, 9), Demand: make([]int, 9)},                                          // 超过 8 点
		{Nodes: 2, Supply: []int{21, 0}, Demand: []int{0, 1}},                                               // 库存超 20
		{Nodes: 2, Supply: []int{1, 0}, Demand: []int{0, -1}},                                               // 负需求
		{Nodes: 2, Supply: []int{1, 0}, Demand: []int{0, 1}, Edges: []Edge{{From: 0, To: 0}}},               // 自环
		{Nodes: 2, Supply: []int{1, 0}, Demand: []int{0, 1}, Edges: []Edge{{From: 0, To: 1, Capacity: -1}}}, // 负容量
	}
	withEdges := base
	for i := 0; i < 11; i++ { // 超过 10 边
		withEdges.Edges = append(withEdges.Edges, Edge{From: 0, To: 1})
	}
	bad = append(bad, withEdges)
	for i, n := range bad {
		if err := Validate(n); err == nil {
			t.Fatalf("用例 %d 应校验失败", i)
		}
		if _, err := Solve(n); err == nil {
			t.Fatalf("用例 %d Solve 应报错", i)
		}
	}
	if err := Validate(base); err != nil {
		t.Fatalf("合法网络校验失败: %v", err)
	}
}
