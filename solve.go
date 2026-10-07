package ratiograph

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// Certificate 是不一致性的环乘积证书：
// Edges 首尾相接构成闭环，沿环方向的比例乘积 Product != 1。
type Certificate struct {
	Edges   []Edge
	Product *big.Rat
}

// Verify 校验证书结构：闭环、比例为正、乘积自洽且不等于 1。
func (c *Certificate) Verify() bool {
	if len(c.Edges) == 0 || c.Product == nil || c.Product.Sign() <= 0 {
		return false
	}
	if c.Product.Cmp(big.NewRat(1, 1)) == 0 {
		return false
	}
	prod := big.NewRat(1, 1)
	for i, e := range c.Edges {
		if e.Ratio == nil || e.Ratio.Sign() <= 0 {
			return false
		}
		if next := c.Edges[(i+1)%len(c.Edges)]; e.V != next.U {
			return false
		}
		prod.Mul(prod, e.Ratio)
	}
	return prod.Cmp(c.Product) == 0
}

func (c *Certificate) String() string {
	parts := make([]string, len(c.Edges))
	for i, e := range c.Edges {
		parts[i] = fmt.Sprintf("%s/%s=%s", e.U, e.V, e.Ratio.RatString())
	}
	return fmt.Sprintf("cycle {%s}, product=%s != 1", strings.Join(parts, ", "), c.Product.RatString())
}

// Component 是一个连通组件的最简正整数比例向量：
// Values 与 Nodes（字典序）一一对应，整体最大公约数为 1。
type Component struct {
	Nodes  []string
	Values []*big.Int
}

// Solution 是全图核验通过后的解：每个连通组件一个最简比例向量。
type Solution struct {
	Components []Component
	index      map[string]*big.Int
}

// Value 返回节点在最简比例向量中的取值。
func (s *Solution) Value(node string) (*big.Int, bool) {
	v, ok := s.index[node]
	return v, ok
}

// Satisfies 用全图势能模型核验解：每条边两端取值之比等于边比例。
func (s *Solution) Satisfies(g *Graph) bool {
	for u, m := range g.adj {
		xu, ok := s.index[u]
		if !ok {
			return false
		}
		for v, r := range m {
			xv, ok := s.index[v]
			if !ok {
				return false
			}
			// x_u / x_v == r  <=>  x_u == x_v * r
			lhs := new(big.Rat).SetInt(xu)
			rhs := new(big.Rat).Mul(new(big.Rat).SetInt(xv), r)
			if lhs.Cmp(rhs) != 0 {
				return false
			}
		}
	}
	return true
}

// solve 全图势能传播：从每个未访问节点赋势能 1 开始 BFS，
// 沿边 x_w = x_v / r 传播；遇到已赋值邻居则核对，冲突即构造环证书。
func (g *Graph) solve() (*Solution, *Certificate) {
	pot := make(map[string]*big.Rat, len(g.adj))
	parent := make(map[string]string, len(g.adj))
	visited := make(map[string]bool, len(g.adj))
	sol := &Solution{index: map[string]*big.Int{}}

	for _, root := range g.Nodes() {
		if visited[root] {
			continue
		}
		pot[root] = big.NewRat(1, 1)
		parent[root] = ""
		visited[root] = true
		queue := []string{root}
		var comp []string
		for len(queue) > 0 {
			v := queue[0]
			queue = queue[1:]
			comp = append(comp, v)
			for _, w := range sortedNeighbors(g.adj[v]) {
				r := g.adj[v][w] // x_v / x_w
				expect := new(big.Rat).Quo(pot[v], r)
				if visited[w] {
					if pot[w].Cmp(expect) != 0 {
						return nil, g.cycleCert(v, w, parent)
					}
					continue
				}
				visited[w] = true
				pot[w] = expect
				parent[w] = v
				queue = append(queue, w)
			}
		}
		c := makeComponent(comp, pot)
		sol.Components = append(sol.Components, c)
		for i, n := range c.Nodes {
			sol.index[n] = c.Values[i]
		}
	}
	return sol, nil
}

// cycleCert 由 BFS 树路径 v~w 加上触发冲突的边 (w, v) 构造环乘积证书。
func (g *Graph) cycleCert(v, w string, parent map[string]string) *Certificate {
	anc := map[string]bool{}
	for x := v; ; x = parent[x] {
		anc[x] = true
		if parent[x] == "" {
			break
		}
	}
	lca := w
	for !anc[lca] {
		lca = parent[lca]
	}

	var edges []Edge
	prod := big.NewRat(1, 1)
	push := func(from, to string) {
		r := g.adj[from][to]
		edges = append(edges, Edge{U: from, V: to, Ratio: new(big.Rat).Set(r)})
		prod.Mul(prod, r)
	}
	for x := v; x != lca; x = parent[x] { // v 上行至 LCA
		push(x, parent[x])
	}
	var down [][2]string
	for x := w; x != lca; x = parent[x] { // LCA 下行至 w（先收集再反转）
		down = append(down, [2]string{parent[x], x})
	}
	for i := len(down) - 1; i >= 0; i-- {
		push(down[i][0], down[i][1])
	}
	push(w, v) // 闭合边
	return &Certificate{Edges: edges, Product: prod}
}

// makeComponent 把组件内的有理数势能化为最简正整数向量：
// 乘分母最小公倍数化为整数，再除以整体最大公约数。
func makeComponent(nodes []string, pot map[string]*big.Rat) Component {
	sort.Strings(nodes)
	lcm := big.NewInt(1)
	for _, n := range nodes {
		d := pot[n].Denom()
		gcd := new(big.Int).GCD(nil, nil, lcm, d)
		lcm.Mul(new(big.Int).Quo(lcm, gcd), d)
	}
	values := make([]*big.Int, len(nodes))
	common := new(big.Int)
	for i, n := range nodes {
		scaled := new(big.Rat).Mul(pot[n], new(big.Rat).SetInt(lcm))
		values[i] = new(big.Int).Set(scaled.Num()) // 分母必为 1
		if i == 0 {
			common.Set(values[i])
		} else {
			common.GCD(nil, nil, common, values[i])
		}
	}
	for i := range values {
		values[i].Quo(values[i], common)
	}
	return Component{Nodes: nodes, Values: values}
}

func sortedNeighbors(m map[string]*big.Rat) []string {
	ns := make([]string, 0, len(m))
	for n := range m {
		ns = append(ns, n)
	}
	sort.Strings(ns)
	return ns
}
