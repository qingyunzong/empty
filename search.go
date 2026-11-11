package q220

import (
	"bytes"
	"sort"
	"strconv"
	"strings"
)

// refine 执行 1-WL 风格的结构分区细化，直到颜色数稳定。
// 种子颜色中每个 IRI 独立成类，匿名节点按当前约束着色；已分配规范编号的
// 匿名节点由调用方赋予互不相同且与其他节点不冲突的种子色。
func refine(g *graph, colors []int) ([]int, int) {
	colorCount := 0
	for _, c := range colors {
		if c+1 > colorCount {
			colorCount = c + 1
		}
	}

	for {
		signatures := make([]string, len(g.nodes))
		for i := range g.nodes {
			var b strings.Builder
			b.WriteString(strconv.Itoa(colors[i]))
			for _, e := range g.adj[i] {
				b.WriteByte('|')
				if e.out {
					b.WriteByte('o')
				} else {
					b.WriteByte('i')
				}
				b.WriteByte(',')
				b.WriteString(strconv.Itoa(e.pred))
				b.WriteByte(',')
				b.WriteString(strconv.Itoa(colors[e.neibor]))
			}
			signatures[i] = b.String()
		}

		order := make([]int, len(g.nodes))
		for i := range order {
			order[i] = i
		}
		sort.Slice(order, func(a, b int) bool {
			x, y := order[a], order[b]
			if colors[x] != colors[y] {
				return colors[x] < colors[y]
			}
			return signatures[x] < signatures[y]
		})

		next := make([]int, len(g.nodes))
		newCount := 0
		prevColor, prevSig := -1, ""
		for _, idx := range order {
			if newCount == 0 || colors[idx] != prevColor || signatures[idx] != prevSig {
				newCount++
				prevColor = colors[idx]
				prevSig = signatures[idx]
			}
			next[idx] = newCount - 1
		}

		if newCount == colorCount {
			return colors, colorCount
		}
		colors, colorCount = next, newCount
	}
}

type searchState struct {
	assign   []int // assign[局部匿名编号] = 规范编号，-1 表示未分配
	used     []bool
	colors   []int
	assigned int
}

// searchCanonical 用结构分区 + 下界剪枝做精确搜索，返回排序后的三元组编码
// 序列与匿名节点排列 perm（perm[局部匿名编号] = 规范编号）。
func searchCanonical(g *graph, stats *Stats) ([][]byte, []int) {
	n := g.blankCount
	perm := make([]int, n)
	if n == 0 {
		return encodeTriples(g, nil, -1), perm
	}

	// 种子颜色：IRI 各自独立，匿名节点同色。
	seed := make([]int, len(g.nodes))
	for i := range g.nodes {
		if i < g.iriCount {
			seed[i] = i
		} else {
			seed[i] = g.iriCount
		}
	}

	rootAssign := make([]int, n)
	for i := range rootAssign {
		rootAssign[i] = -1
	}
	// 松弛编码只能充当子树下界；上界必须来自真实完整赋值，
	// 因此首个到达的叶子直接成为初始 best。
	var best [][]byte
	bestPerm := make([]int, n)

	var dfs func(st *searchState)
	dfs = func(st *searchState) {
		stats.Refinements++
		st.colors, _ = refine(g, st.colors)

		if st.assigned == n {
			stats.Leaves++
			cand := encodeTriples(g, st.assign, -1)
			if best == nil {
				best = cand
				copy(bestPerm, st.assign)
			} else {
				switch compareTripleSeq(cand, best) {
				case -1:
					best = cand
					copy(bestPerm, st.assign)
				case 0:
					if permLess(st.assign, bestPerm) {
						copy(bestPerm, st.assign)
					}
				}
			}
			return
		}

		// 选择含未分配匿名节点的颜色号最小的块，块内取局部编号最小的节点。
		node := selectNode(g, st)

		for d := 0; d < n; d++ {
			if st.used[d] {
				continue
			}
			stats.Branches++

			child := cloneState(g, st)
			local := g.localBlank(node)
			child.assign[local] = d
			child.used[d] = true
			child.assigned++
			// 已分配节点使用与所有现有颜色不冲突的独立种子色。
			child.colors[node] = len(g.nodes) + 1 + d

			if child.assigned < n {
				m := smallestUnused(child.used)
				bound := encodeTriples(g, child.assign, m)
				// 松弛序列不劣于该子树任意完整赋值；尚无可行解或严格更差才处理，
				// 相等时保留以维持“同值取排列字典序最小”的精确语义。
				if best != nil && compareTripleSeq(bound, best) > 0 {
					stats.Bounds++
					continue
				}
			}
			dfs(child)
		}
	}

	dfs(&searchState{
		assign:   rootAssign,
		used:     make([]bool, n),
		colors:   seed,
		assigned: 0,
	})

	return best, bestPerm
}

func selectNode(g *graph, st *searchState) int {
	blockColor := -1
	for nodeID := g.iriCount; nodeID < len(g.nodes); nodeID++ {
		local := g.localBlank(nodeID)
		if st.assign[local] != -1 {
			continue
		}
		if blockColor == -1 || st.colors[nodeID] < blockColor {
			blockColor = st.colors[nodeID]
		}
	}
	chosen := -1
	for nodeID := g.iriCount; nodeID < len(g.nodes); nodeID++ {
		local := g.localBlank(nodeID)
		if st.assign[local] != -1 {
			continue
		}
		if st.colors[nodeID] != blockColor {
			continue
		}
		if chosen == -1 || local < g.localBlank(chosen) {
			chosen = nodeID
		}
	}
	return chosen
}

func cloneState(g *graph, st *searchState) *searchState {
	colors := make([]int, len(g.nodes))
	copy(colors, st.colors)
	assign := make([]int, len(st.assign))
	copy(assign, st.assign)
	used := make([]bool, len(st.used))
	copy(used, st.used)
	return &searchState{assign: assign, used: used, colors: colors, assigned: st.assigned}
}

func smallestUnused(used []bool) int {
	for i, u := range used {
		if !u {
			return i
		}
	}
	return -1
}

// encodeTriples 返回当前赋值下排序后的三元组编码序列。
// assign[局部匿名编号] 为 -1 的未分配匿名节点统一用 relaxedDigit 松弛；
// relaxedDigit 传 -1 时要求全部匿名节点均已分配。
func encodeTriples(g *graph, assign []int, relaxedDigit int) [][]byte {
	out := make([][]byte, 0, len(g.triples))
	for _, t := range g.triples {
		out = append(out, encodeTriple(g, t, assign, relaxedDigit))
	}
	sort.Slice(out, func(i, j int) bool {
		return bytes.Compare(out[i], out[j]) < 0
	})
	return out
}

func encodeTriple(g *graph, t indexedTriple, assign []int, relaxedDigit int) []byte {
	parts := [3][]byte{
		encodeTerm(g, t.s, assign, relaxedDigit),
		encodeTerm(g, t.p, assign, relaxedDigit),
		encodeTerm(g, t.o, assign, relaxedDigit),
	}
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	buf := make([]byte, 0, total)
	for _, p := range parts {
		buf = append(buf, p...)
	}
	return buf
}

func encodeTerm(g *graph, nodeID int, assign []int, relaxedDigit int) []byte {
	n := g.nodes[nodeID]
	if n.Type == IRI {
		return EncodeNode(n)
	}
	digit := assign[g.localBlank(nodeID)]
	if digit == -1 {
		digit = relaxedDigit
	}
	return EncodeNode(Node{Type: Blank, Value: strconv.Itoa(digit)})
}

// compareTripleSeq 按三元组编码序列逐元素做字节字典序比较。
// 每个松弛三元组与对应真实三元组等长且逐项不大于它，因此排序后的松弛
// 序列的各阶序统计量都不大于真实序列，下界剪枝保持精确。
func compareTripleSeq(a, b [][]byte) int {
	k := len(a)
	if len(b) < k {
		k = len(b)
	}
	for i := 0; i < k; i++ {
		if c := bytes.Compare(a[i], b[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}

func permLess(a, b []int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func buildResult(g *graph, seq [][]byte, perm []int) *Result {
	canonOf := func(nodeID int) CanonicalNode {
		n := g.nodes[nodeID]
		if n.Type == IRI {
			return CanonicalNode{Type: IRI, Value: n.Value}
		}
		return CanonicalNode{Type: Blank, Value: strconv.Itoa(perm[g.localBlank(nodeID)])}
	}

	// seq 已按编码字节排序，按相同顺序重建结构化三元组。
	indexOf := make(map[string]int, len(g.triples))
	encoded := make([][]byte, len(g.triples))
	for i, t := range g.triples {
		b := encodeTriple(g, t, perm, -1)
		encoded[i] = b
		indexOf[string(b)] = i
	}
	sort.Slice(encoded, func(i, j int) bool {
		return bytes.Compare(encoded[i], encoded[j]) < 0
	})

	triples := make([]CanonicalTriple, 0, len(g.triples))
	for _, b := range encoded {
		t := g.triples[indexOf[string(b)]]
		triples = append(triples, CanonicalTriple{
			Subject:   canonOf(t.s),
			Predicate: canonOf(t.p),
			Object:    canonOf(t.o),
		})
	}

	mapping := make([]NodeMapping, 0, len(g.firstSeen))
	for _, nodeID := range g.firstSeen {
		mapping = append(mapping, NodeMapping{
			Source:    g.nodes[nodeID],
			Canonical: canonOf(nodeID),
		})
	}

	total := 0
	for _, b := range seq {
		total += len(b)
	}
	encoding := make([]byte, 0, total)
	for _, b := range seq {
		encoding = append(encoding, b...)
	}

	return &Result{
		Encoding:   encoding,
		Triples:    triples,
		Mapping:    mapping,
		BlankCount: g.blankCount,
	}
}
