package dataeng

import "sort"

// graph 是代入证据后的无向因子图：证据变量不入图，所有未固定变量
// （包括没有任何因子提及的孤立变量）都有对应节点。
type graph struct {
	adj map[int]map[int]bool
}

func newGraph() *graph {
	return &graph{adj: make(map[int]map[int]bool)}
}

func (g *graph) addNode(v int) {
	if _, ok := g.adj[v]; !ok {
		g.adj[v] = make(map[int]bool)
	}
}

// addClique 让 scope 内所有变量两两成团，单变量 scope 仅保证节点存在。
func (g *graph) addClique(scope []int) {
	for _, v := range scope {
		g.addNode(v)
	}
	for i := 0; i < len(scope); i++ {
		for j := i + 1; j < len(scope); j++ {
			a, b := scope[i], scope[j]
			g.adj[a][b] = true
			g.adj[b][a] = true
		}
	}
}

// fillEdges 计算消去 v 需要新增的填充边（当前尚不存在的邻居对）。
// 邻居与边端点均按变量 ID 的 ASCII 字典序排列。
func (m *Model) fillEdges(g *graph, v int) [][2]int {
	neighbors := make([]int, 0, len(g.adj[v]))
	for n := range g.adj[v] {
		neighbors = append(neighbors, n)
	}
	sort.Slice(neighbors, func(i, j int) bool {
		return m.vars[neighbors[i]].ID < m.vars[neighbors[j]].ID
	})
	var fills [][2]int
	for i := 0; i < len(neighbors); i++ {
		for j := i + 1; j < len(neighbors); j++ {
			a, b := neighbors[i], neighbors[j]
			if !g.adj[a][b] {
				fills = append(fills, [2]int{a, b})
			}
		}
	}
	return fills
}

func (g *graph) applyFills(v int, fills [][2]int) {
	for _, e := range fills {
		a, b := e[0], e[1]
		g.adj[a][b] = true
		g.adj[b][a] = true
	}
}

func (g *graph) eliminate(v int) {
	for n := range g.adj[v] {
		delete(g.adj[n], v)
	}
	delete(g.adj, v)
}

// pickHidden 按三级准则在隐藏变量中选择消元变量：
//  1. 新增填充边数最少
//  2. 当前邻居域大小之积最小
//  3. ID 的 ASCII 字典序最小
func (m *Model) pickHidden(g *graph, hidden map[int]bool) int {
	candidates := make([]int, 0, len(hidden))
	for v := range hidden {
		candidates = append(candidates, v)
	}
	sort.Ints(candidates)

	best := -1
	var bestFills int
	var bestProduct int
	for _, v := range candidates {
		fills := len(m.fillEdges(g, v))
		product := 1
		for n := range g.adj[v] {
			product *= m.domSize[n]
		}
		if best == -1 ||
			fills < bestFills ||
			(fills == bestFills && product < bestProduct) ||
			(fills == bestFills && product == bestProduct && m.vars[v].ID < m.vars[best].ID) {
			best, bestFills, bestProduct = v, fills, product
		}
	}
	return best
}
