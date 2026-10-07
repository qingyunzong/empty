// Package ratiograph 维护变量间的正有理数比例约束图。
//
// 每条边 (u, v, r) 表示约束 x_u / x_v = r（r 为正有理数）。
// 每次批量增删后，库会用全图势能传播模型重新核验：
//   - 一致时，每个连通组件输出最简正整数比例向量；
//   - 不一致时，返回一个环乘积证书（沿环比例乘积 != 1）。
package ratiograph

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// Edge 表示约束 x_U / x_V = Ratio，Ratio 必须为正有理数。
type Edge struct {
	U, V  string
	Ratio *big.Rat
}

// NewEdge 构造边 x_U/x_V = num/den，num、den 必须为正整数。
func NewEdge(u, v string, num, den int64) Edge {
	return Edge{U: u, V: v, Ratio: big.NewRat(num, den)}
}

// Op 表示一条批量操作：Add 为 true 时增边，否则按端点删边（忽略 Ratio）。
type Op struct {
	Add  bool
	Edge Edge
}

// AddOp 构造增边操作。
func AddOp(e Edge) Op { return Op{Add: true, Edge: e} }

// RemoveOp 构造删边操作，端点无序。
func RemoveOp(u, v string) Op { return Op{Edge: Edge{U: u, V: v}} }

// Graph 是比例约束图，内部以邻接表存储，adj[u][v] = x_u / x_v。
type Graph struct {
	adj map[string]map[string]*big.Rat
}

// New 返回空图。
func New() *Graph { return &Graph{adj: map[string]map[string]*big.Rat{}} }

func (g *Graph) clone() *Graph {
	h := New()
	for u, m := range g.adj {
		h.adj[u] = make(map[string]*big.Rat, len(m))
		for v, r := range m {
			h.adj[u][v] = new(big.Rat).Set(r)
		}
	}
	return h
}

// HasEdge 报告节点 u、v 之间是否存在边（无序）。
func (g *Graph) HasEdge(u, v string) bool {
	_, ok := g.adj[u][v]
	return ok
}

// EdgeCount 返回无向边数量。
func (g *Graph) EdgeCount() int {
	deg := 0
	for _, m := range g.adj {
		deg += len(m)
	}
	return deg / 2
}

// Nodes 返回排序后的节点列表。
func (g *Graph) Nodes() []string {
	nodes := make([]string, 0, len(g.adj))
	for u := range g.adj {
		nodes = append(nodes, u)
	}
	sort.Strings(nodes)
	return nodes
}

func (g *Graph) addEdge(e Edge) {
	if g.adj[e.U] == nil {
		g.adj[e.U] = map[string]*big.Rat{}
	}
	if g.adj[e.V] == nil {
		g.adj[e.V] = map[string]*big.Rat{}
	}
	g.adj[e.U][e.V] = new(big.Rat).Set(e.Ratio)
	g.adj[e.V][e.U] = new(big.Rat).Inv(e.Ratio)
}

func (g *Graph) removeEdge(u, v string) {
	delete(g.adj[u], v)
	delete(g.adj[v], u)
	if len(g.adj[u]) == 0 {
		delete(g.adj, u)
	}
	if len(g.adj[v]) == 0 {
		delete(g.adj, v)
	}
}

// applyOp 在（克隆）图上应用单条操作。
// 返回证书表示该操作本身即导致不一致（非 1 自环）。
func (g *Graph) applyOp(op Op) (*Certificate, error) {
	e := op.Edge
	if e.U == "" || e.V == "" {
		return nil, errors.New("ratiograph: empty node name")
	}
	if !op.Add {
		if e.U == e.V || !g.HasEdge(e.U, e.V) {
			return nil, fmt.Errorf("ratiograph: cannot remove missing edge {%s, %s}", e.U, e.V)
		}
		g.removeEdge(e.U, e.V)
		return nil, nil
	}
	if e.Ratio == nil || e.Ratio.Sign() <= 0 {
		return nil, fmt.Errorf("ratiograph: edge {%s, %s} ratio must be a positive rational", e.U, e.V)
	}
	if e.U == e.V {
		if e.Ratio.Cmp(big.NewRat(1, 1)) != 0 {
			// 自环 x_u/x_u = r != 1，自身即环乘积证书。
			return &Certificate{
				Edges:   []Edge{{U: e.U, V: e.V, Ratio: new(big.Rat).Set(e.Ratio)}},
				Product: new(big.Rat).Set(e.Ratio),
			}, nil
		}
		return nil, nil // 恒等自环，无约束，忽略
	}
	if g.HasEdge(e.U, e.V) {
		return nil, fmt.Errorf("ratiograph: duplicate edge {%s, %s}", e.U, e.V)
	}
	g.addEdge(e)
	return nil, nil
}

// Apply 原子地应用一批增删操作，并用全图势能传播模型核验结果。
//
//   - 全部合法且核验通过：提交修改，返回全图解；
//   - 核验发现不一致：返回环乘积证书，原图保持不变；
//   - 操作本身非法（重复增、删不存在、非正比例等）：返回 error，原图保持不变。
func (g *Graph) Apply(ops ...Op) (*Solution, *Certificate, error) {
	h := g.clone()
	for _, op := range ops {
		cert, err := h.applyOp(op)
		if err != nil {
			return nil, nil, err
		}
		if cert != nil {
			return nil, cert, nil
		}
	}
	sol, cert := h.solve()
	if cert != nil {
		return nil, cert, nil
	}
	g.adj = h.adj
	return sol, nil, nil
}

// Solve 对当前图执行全图势能传播核验，等价于 Apply() 空批。
func (g *Graph) Solve() (*Solution, *Certificate) {
	return g.clone().solve()
}
