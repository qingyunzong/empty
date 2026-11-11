package q220

import (
	"fmt"
	"sort"
)

// edge 描述颜色细化使用的有向邻接关系。
type edge struct {
	out    bool // true=出边（本节点是主语），false=入边（本节点是宾语）
	pred   int  // 谓词节点编号（恒为 IRI）
	neibor int  // 对端节点编号
}

type indexedTriple struct {
	s, p, o int
}

// graph 是去重、排序后的内部图表示。
// 节点编号规则：先全部 IRI（按文本字节序），再全部匿名节点（按标识字节序）。
type graph struct {
	nodes      []Node
	iriCount   int
	blankCount int
	blankIndex map[string]int // 原匿名标识 -> 节点编号
	triples    []indexedTriple
	adj        [][]edge
	// order 记录节点在输入三元组中的首次出现顺序，用于输出稳定的 Mapping。
	firstSeen []int
}

type tripleKey struct {
	st byte
	sv string
	pt byte
	pv string
	ot byte
	ov string
}

func buildGraph(input []Triple) (*graph, error) {
	seen := make(map[tripleKey]struct{})
	iris := make(map[string]struct{})
	blanks := make(map[string]struct{})
	seenOrder := make([]Node, 0)
	nodeSeen := make(map[Node]int)

	addSeen := func(n Node) {
		if _, ok := nodeSeen[n]; !ok {
			nodeSeen[n] = len(seenOrder)
			seenOrder = append(seenOrder, n)
		}
	}

	for _, t := range input {
		for _, n := range [3]Node{t.Subject, t.Predicate, t.Object} {
			if n.Type != IRI && n.Type != Blank {
				return nil, ErrInvalidNodeType
			}
			if n.Value == "" {
				return nil, ErrEmptyNode
			}
		}
		if t.Predicate.Type != IRI {
			return nil, ErrPredicateIRI
		}
		key := tripleKey{
			st: byte(t.Subject.Type), sv: t.Subject.Value,
			pt: byte(t.Predicate.Type), pv: t.Predicate.Value,
			ot: byte(t.Object.Type), ov: t.Object.Value,
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}

		addSeen(t.Subject)
		addSeen(t.Predicate)
		addSeen(t.Object)
		if t.Subject.Type == IRI {
			iris[t.Subject.Value] = struct{}{}
		} else {
			blanks[t.Subject.Value] = struct{}{}
		}
		if t.Object.Type == IRI {
			iris[t.Object.Value] = struct{}{}
		} else {
			blanks[t.Object.Value] = struct{}{}
		}
		iris[t.Predicate.Value] = struct{}{}
	}

	if len(blanks) > MaxBlanks {
		return nil, fmt.Errorf("%w: have %d, max %d", ErrTooManyBlanks, len(blanks), MaxBlanks)
	}

	iriList := sortedKeys(iris)
	blankList := sortedKeys(blanks)

	g := &graph{
		iriCount:   len(iriList),
		blankCount: len(blankList),
		blankIndex: make(map[string]int, len(blankList)),
	}
	for _, v := range iriList {
		g.nodes = append(g.nodes, Node{Type: IRI, Value: v})
	}
	for _, v := range blankList {
		idx := len(g.nodes)
		g.nodes = append(g.nodes, Node{Type: Blank, Value: v})
		g.blankIndex[v] = idx
	}
	g.adj = make([][]edge, len(g.nodes))

	idOf := make(map[Node]int, len(g.nodes))
	for i, n := range g.nodes {
		idOf[n] = i
	}

	for _, t := range input {
		key := tripleKey{
			st: byte(t.Subject.Type), sv: t.Subject.Value,
			pt: byte(t.Predicate.Type), pv: t.Predicate.Value,
			ot: byte(t.Object.Type), ov: t.Object.Value,
		}
		if _, ok := seen[key]; !ok {
			continue
		}
		delete(seen, key)
		s, p, o := idOf[t.Subject], idOf[t.Predicate], idOf[t.Object]
		g.triples = append(g.triples, indexedTriple{s, p, o})
		g.adj[s] = append(g.adj[s], edge{out: true, pred: p, neibor: o})
		g.adj[o] = append(g.adj[o], edge{out: false, pred: p, neibor: s})
	}

	sort.Slice(g.triples, func(i, j int) bool {
		a, b := g.triples[i], g.triples[j]
		if a.s != b.s {
			return a.s < b.s
		}
		if a.p != b.p {
			return a.p < b.p
		}
		return a.o < b.o
	})
	for i := range g.adj {
		sort.Slice(g.adj[i], func(a, b int) bool {
			x, y := g.adj[i][a], g.adj[i][b]
			if x.out != y.out {
				return x.out
			}
			if x.pred != y.pred {
				return x.pred < y.pred
			}
			return x.neibor < y.neibor
		})
	}

	g.firstSeen = make([]int, 0, len(seenOrder))
	for _, n := range seenOrder {
		g.firstSeen = append(g.firstSeen, idOf[n])
	}
	return g, nil
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// localBlank 把节点编号转换为匿名节点的局部编号 0..n-1（仅对匿名节点有效）。
func (g *graph) localBlank(nodeID int) int {
	return nodeID - g.iriCount
}
