package main

import (
	"fmt"
	"sort"
)

// Edge 为 MVSG 中的一条冲突边。Kind ∈ {WR, WW, RW}。
type Edge struct {
	From, To int
	Kind     string
	Item     string
	Note     string
}

func (e Edge) String() string {
	return fmt.Sprintf("T%d -%s(%s)-> T%d", e.From, e.Kind, e.Item, e.To)
}

// Graph 为多版本依赖图，版本序取历史中写操作的先后。
// 图的边精确编码串行重放语义（读到的版本 = 版本序下最新的
// 已写版本）的约束，使"无环 <=> 存在有效串行序"成立。
type Graph struct {
	Txns  []int
	Edges []Edge
	adj   map[int][]Edge
}

// BuildGraph 构造依赖图，对每条读操作 Rk(x_j)（Tk 读版本 x_j）：
//   - 若 j != k：加 WR 边 Tj -> Tk（写者必须先于读者，版本才可用）
//   - 对 x 的每个其他写者 Tw（w != j, w != k）：若 x_w 在版本序中
//     晚于 x_j，加 RW 边 Tk -> Tw（读者必须先于该写者，否则更新
//     的版本会遮蔽 x_j）
//
// 版本序更旧的版本不会遮蔽 x_j，无需加边；自环边跳过。
func BuildGraph(h *History) *Graph {
	g := &Graph{Txns: h.Txns, adj: map[int][]Edge{}}
	writePos := map[string]map[int]int{}
	writers := map[string][]int{}
	for _, op := range h.Ops {
		if op.Kind != 'W' {
			continue
		}
		if writePos[op.Item] == nil {
			writePos[op.Item] = map[int]int{}
		}
		writePos[op.Item][op.Txn] = op.Pos
		writers[op.Item] = append(writers[op.Item], op.Txn)
	}
	seen := map[string]bool{}
	add := func(e Edge) {
		if e.From == e.To {
			return
		}
		key := fmt.Sprintf("%d|%d|%s|%s|%s", e.From, e.To, e.Kind, e.Item, e.Note)
		if seen[key] {
			return
		}
		seen[key] = true
		g.Edges = append(g.Edges, e)
		g.adj[e.From] = append(g.adj[e.From], e)
	}
	for _, op := range h.Ops {
		if op.Kind != 'R' {
			continue
		}
		reader, writer := op.Txn, op.Version
		if reader != writer {
			add(Edge{writer, reader, "WR", op.Item,
				fmt.Sprintf("T%d 读取 T%d 写入的 %s%d", reader, writer, op.Item, writer)})
		}
		for _, other := range writers[op.Item] {
			if other == writer || other == reader {
				continue
			}
			if writePos[op.Item][other] > writePos[op.Item][writer] {
				add(Edge{reader, other, "RW", op.Item,
					fmt.Sprintf("T%d 读过 %s%d，T%d 写入更新版本 %s%d",
						reader, op.Item, writer, other, op.Item, other)})
			}
		}
	}
	sort.Slice(g.Edges, func(i, j int) bool {
		a, b := g.Edges[i], g.Edges[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.To != b.To {
			return a.To < b.To
		}
		if a.Item != b.Item {
			return a.Item < b.Item
		}
		return a.Kind < b.Kind
	})
	return g
}

// SCCs 返回所有非平凡强连通分量（大小 > 1），按最小成员排序。
func (g *Graph) SCCs() [][]int {
	index := map[int]int{}
	low := map[int]int{}
	onStack := map[int]bool{}
	var stack []int
	var sccs [][]int
	counter := 0
	var strongconnect func(v int)
	strongconnect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for _, e := range g.adj[v] {
			w := e.To
			if _, ok := index[w]; !ok {
				strongconnect(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] {
				if index[w] < low[v] {
					low[v] = index[w]
				}
			}
		}
		if low[v] == index[v] {
			var scc []int
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				scc = append(scc, w)
				if w == v {
					break
				}
			}
			sort.Ints(scc)
			sccs = append(sccs, scc)
		}
	}
	for _, t := range g.Txns {
		if _, ok := index[t]; !ok {
			strongconnect(t)
		}
	}
	var out [][]int
	for _, s := range sccs {
		if len(s) > 1 {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out
}

// CycleIn 在 SCC 内从最小 ID 节点出发，找一条回到起点的具体边链。
func (g *Graph) CycleIn(scc []int) []Edge {
	in := map[int]bool{}
	for _, t := range scc {
		in[t] = true
	}
	start := scc[0]
	var path []Edge
	visited := map[int]bool{start: true}
	var dfs func(v int) bool
	dfs = func(v int) bool {
		for _, e := range g.adj[v] {
			if !in[e.To] {
				continue
			}
			if e.To == start {
				path = append(path, e)
				return true
			}
			if visited[e.To] {
				continue
			}
			visited[e.To] = true
			path = append(path, e)
			if dfs(e.To) {
				return true
			}
			path = path[:len(path)-1]
		}
		return false
	}
	dfs(start)
	return path
}

// TopoRound 记录一轮 Kahn 算法的候选与选择。
type TopoRound struct {
	Candidates []int
	Picked     int
}

// TopoMinID 执行 Kahn 拓扑排序，每轮从入度为 0 的节点中选 ID 最小者。
func (g *Graph) TopoMinID() (order []int, rounds []TopoRound, ok bool) {
	indeg := map[int]int{}
	for _, t := range g.Txns {
		indeg[t] = 0
	}
	for _, e := range g.Edges {
		indeg[e.To]++
	}
	removed := map[int]bool{}
	for len(order) < len(g.Txns) {
		var cand []int
		for _, t := range g.Txns {
			if !removed[t] && indeg[t] == 0 {
				cand = append(cand, t)
			}
		}
		if len(cand) == 0 {
			return order, rounds, false
		}
		sort.Ints(cand)
		pick := cand[0]
		rounds = append(rounds, TopoRound{Candidates: cand, Picked: pick})
		removed[pick] = true
		order = append(order, pick)
		for _, e := range g.adj[pick] {
			indeg[e.To]--
		}
	}
	return order, rounds, true
}
