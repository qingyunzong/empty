package dataeng

import (
	"math/rand"
	"sort"
	"testing"
)

// testCell 是外键单元格的字节序可比标识。
type testCell struct {
	tableID string
	rowID   string
	fieldID string
}

func (c testCell) less(o testCell) bool {
	if c.tableID != o.tableID {
		return c.tableID < o.tableID
	}
	if c.rowID != o.rowID {
		return c.rowID < o.rowID
	}
	return c.fieldID < o.fieldID
}

// testEdge 是测试图中的一条行级边。
type testEdge struct {
	from, to int
	cell     testCell
	nullable bool
}

type testGraph struct {
	rowTable []string // 每个顶点所属表 ID
	rowID    []string // 每个顶点的行 ID
	edges    []testEdge
}

func (g *testGraph) rowRef(v int) RowRef {
	return RowRef{TableID: g.rowTable[v], RowID: g.rowID[v]}
}

// toRequest 把测试图转换为生产 API 的输入。
func (g *testGraph) toRequest() ([]RowRef, []Reference) {
	rows := make([]RowRef, len(g.rowID))
	for v := range rows {
		rows[v] = g.rowRef(v)
	}
	refs := make([]Reference, 0, len(g.edges))
	for _, e := range g.edges {
		target := g.rowRef(e.to)
		refs = append(refs, Reference{
			Source:   g.rowRef(e.from),
			FieldID:  e.cell.fieldID,
			Target:   &target,
			Nullable: e.nullable,
		})
	}
	return rows, refs
}

// independentHasCycle 是不依赖生产代码的 DFS 有环判定（含自环）。
func independentHasCycle(n int, edges []testEdge, keep func(testEdge) bool) bool {
	adj := make([][]int, n)
	for _, e := range edges {
		if keep != nil && !keep(e) {
			continue
		}
		if e.from == e.to {
			return true
		}
		adj[e.from] = append(adj[e.from], e.to)
	}
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make([]int, n)
	var dfs func(u int) bool
	dfs = func(u int) bool {
		color[u] = gray
		for _, v := range adj[u] {
			if color[v] == gray {
				return true
			}
			if color[v] == white && dfs(v) {
				return true
			}
		}
		color[u] = black
		return false
	}
	for v := 0; v < n; v++ {
		if color[v] == white && dfs(v) {
			return true
		}
	}
	return false
}

// independentMinDeferral 用全子集暴力枚举求最少延迟边，并按字节序列字典序裁决。
// 返回最优延迟边在候选列表（字节序排序后）中的位掩码。
func independentMinDeferral(g *testGraph) (mask uint32, fixedCyclic bool, candidates []testEdge) {
	var fixed, cands []testEdge
	for _, e := range g.edges {
		if e.nullable {
			cands = append(cands, e)
		} else {
			fixed = append(fixed, e)
		}
	}
	if independentHasCycle(len(g.rowID), fixed, nil) {
		return 0, true, cands
	}
	sort.SliceStable(cands, func(i, j int) bool {
		return cands[i].cell.less(cands[j].cell)
	})
	m := len(cands)
	best := ^uint32(0)
	for sub := uint32(0); sub < 1<<uint(m); sub++ {
		removed := sub
		// 固定边始终保留；仅候选边可被延迟。有环判定必须在全图上做，
		// 否则会漏掉“候选边 + 固定边”构成的混合环。
		ok := !independentHasCycle(len(g.rowID), g.edges, func(e testEdge) bool {
			if !e.nullable {
				return true
			}
			idx := sort.Search(len(cands), func(i int) bool {
				return !cands[i].cell.less(e.cell)
			})
			return removed&(1<<uint(idx)) == 0
		})
		if !ok {
			continue
		}
		if best == ^uint32(0) || popcount(removed) < popcount(best) ||
			(popcount(removed) == popcount(best) && maskSetLess(removed, best, m)) {
			best = removed
		}
	}
	return best, false, cands
}

// maskSetLess 比较两个等基数集合的字典序：按下标升序逐项比较，
// 第一个更小元素所在的集合胜出（对应字节序列字典序更小）。
func maskSetLess(a, b uint32, m int) bool {
	for i := 0; i < m; i++ {
		abit := a&(1<<uint(i)) != 0
		bbit := b&(1<<uint(i)) != 0
		if abit != bbit {
			return abit
		}
	}
	return false
}

func popcount(x uint32) int {
	n := 0
	for x != 0 {
		x &= x - 1
		n++
	}
	return n
}

// independentTopo 独立实现“就绪行按表 ID、行 ID 字节序”的拓扑排序，
// 边方向约定为 source 依赖 target（target 必须先装载）。
func independentTopo(g *testGraph, active []testEdge) []RowRef {
	n := len(g.rowID)
	indeg := make([]int, n)
	dependents := make([][]int, n)
	for _, e := range active {
		dependents[e.to] = append(dependents[e.to], e.from)
		indeg[e.from]++
	}
	ready := make([]int, 0, n)
	for v := 0; v < n; v++ {
		if indeg[v] == 0 {
			ready = append(ready, v)
		}
	}
	var order []RowRef
	for len(ready) > 0 {
		best := 0
		for i := 1; i < len(ready); i++ {
			if g.rowRef(ready[i]).less(g.rowRef(ready[best])) {
				best = i
			}
		}
		v := ready[best]
		ready = append(ready[:best], ready[best+1:]...)
		order = append(order, g.rowRef(v))
		for _, w := range dependents[v] {
			indeg[w]--
			if indeg[w] == 0 {
				ready = append(ready, w)
			}
		}
	}
	return order
}

func errorIs(got, want error) bool {
	type unwrapper interface{ Unwrap() error }
	for got != nil {
		if got == want {
			return true
		}
		u, ok := got.(unwrapper)
		if !ok {
			return false
		}
		got = u.Unwrap()
	}
	return false
}

// checkGraphAgainstOracle 用独立预言机完整核验一张测试图的规划结果。
func checkGraphAgainstOracle(t *testing.T, g *testGraph) {
	t.Helper()
	wantMask, fixedCyclic, sortedCands := independentMinDeferral(g)
	rows, refs := g.toRequest()
	plan, err := BuildPlan(rows, refs)

	if fixedCyclic {
		if err == nil {
			t.Fatalf("fixed-cycle graph unexpectedly planned: %+v", g.edges)
		}
		if !errorIs(err, ErrNonDeferrableCycle) {
			t.Fatalf("want ErrNonDeferrableCycle, got %v", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("recoverable graph failed: %v\nedges=%+v", err, g.edges)
	}

	// 核验延迟边集合与预言机完全一致（基数最少 + 字节序列字典序）。
	if len(plan.DeferredFields) != popcount(wantMask) {
		t.Fatalf("deferred count=%d want=%d", len(plan.DeferredFields), popcount(wantMask))
	}
	gotMask := uint32(0)
	for i, c := range sortedCands {
		for _, d := range plan.DeferredFields {
			if d.Source.TableID == c.cell.tableID &&
				d.Source.RowID == c.cell.rowID &&
				d.FieldID == c.cell.fieldID {
				gotMask |= 1 << uint(i)
			}
		}
	}
	if gotMask != wantMask {
		t.Fatalf("deferred mask=%0*b want=%0*b\nedges=%+v",
			len(sortedCands), gotMask, len(sortedCands), wantMask, g.edges)
	}

	// 核验补写与延迟字段一一对应且按字节序排列。
	if len(plan.Backfills) != len(plan.DeferredFields) {
		t.Fatalf("backfill/deferred length mismatch")
	}
	for i, b := range plan.Backfills {
		d := plan.DeferredFields[i]
		if b.Source != d.Source || b.FieldID != d.FieldID || b.Target != *d.Target {
			t.Fatalf("backfill %+v mismatch deferred %+v", b, d)
		}
		if i > 0 {
			prev := plan.Backfills[i-1]
			cur := testCell{b.Source.TableID, b.Source.RowID, b.FieldID}
			old := testCell{prev.Source.TableID, prev.Source.RowID, prev.FieldID}
			if cur.less(old) {
				t.Fatalf("backfills not byte-order sorted at %d", i)
			}
		}
	}

	// 核验装载顺序与独立拓扑排序一致，并满足所有非延迟依赖。
	deferredCells := map[testCell]bool{}
	for _, d := range plan.DeferredFields {
		deferredCells[testCell{d.Source.TableID, d.Source.RowID, d.FieldID}] = true
	}
	var active []testEdge
	for _, e := range g.edges {
		if !deferredCells[e.cell] {
			active = append(active, e)
		}
	}
	wantOrder := independentTopo(g, active)
	if len(wantOrder) != len(rows) {
		t.Fatalf("oracle topo failed to cover all rows")
	}
	assertRowSequence(t, plan.LoadOrder, wantOrder)

	// 可恢复性终态核验：装载加补写结束后，每条非 null 外键都指向已存在的行。
	loaded := map[RowRef]bool{}
	for _, r := range plan.LoadOrder {
		loaded[r] = true
	}
	for _, b := range plan.Backfills {
		if !loaded[b.Source] || !loaded[b.Target] {
			t.Fatalf("backfill references unloaded row: %+v", b)
		}
	}
	for _, r := range refs {
		if r.Target != nil && !loaded[*r.Target] {
			t.Fatalf("reference target never loaded: %+v", r)
		}
	}
}

// TestExhaustiveSmallGraphs 对 n=1..3 的所有“边存在性 × 边类型”组合做全子集核验。
// 每个有序顶点对取“无边 / 仅固定边 / 仅可空边”三态，覆盖自环、纯固定边环
// 与多环交织等全部小图形态。
func TestExhaustiveSmallGraphs(t *testing.T) {
	for n := 1; n <= 3; n++ {
		pairs := n * n // 有序对，包含自环 (u,u)
		total := 1
		for range make([]struct{}, pairs) {
			total *= 3
		}
		for code := 0; code < total; code++ {
			g := &testGraph{
				rowTable: make([]string, n),
				rowID:    make([]string, n),
			}
			for v := 0; v < n; v++ {
				// 顶点分属不同表，顺带核验跨表字节序。
				g.rowTable[v] = string(rune('T' + (v % 2)))
				g.rowID[v] = "r" + string(rune('0'+v))
			}
			c := code
			for u := 0; u < n; u++ {
				for v := 0; v < n; v++ {
					mode := c % 3
					c /= 3
					if mode == 0 {
						continue
					}
					g.edges = append(g.edges, testEdge{
						from: u,
						to:   v,
						cell: testCell{
							tableID: g.rowTable[u],
							rowID:   g.rowID[u],
							fieldID: "fk_" + g.rowID[v],
						},
						nullable: mode == 2,
					})
				}
			}
			checkGraphAgainstOracle(t, g)
		}
	}
}

// TestRandomLargerGraphs 在 n=4..6 上做随机抽样，补充固定+可空平行边、
// 多表字节序与自环混合场景；若候选边超过上限，断言 API 返回对应错误。
func TestRandomLargerGraphs(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	tables := []string{"A", "B", "C"}
	for iter := 0; iter < 2000; iter++ {
		n := 4 + rng.Intn(3)
		g := &testGraph{
			rowTable: make([]string, n),
			rowID:    make([]string, n),
		}
		for v := 0; v < n; v++ {
			g.rowTable[v] = tables[rng.Intn(len(tables))]
			g.rowID[v] = "row" + string(rune('a'+v)) + string(rune('0'+rng.Intn(10)))
		}
		usedCells := map[testCell]bool{}
		nullableCount := 0
		for u := 0; u < n; u++ {
			for v := 0; v < n; v++ {
				for _, kind := range []int{0, 1} { // 平行的固定边与可空边
					if rng.Intn(2) == 0 {
						continue
					}
					cell := testCell{
						tableID: g.rowTable[u],
						rowID:   g.rowID[u],
						fieldID: []string{"fix_", "nul_"}[kind] + g.rowID[v],
					}
					if usedCells[cell] {
						continue
					}
					usedCells[cell] = true
					nullable := kind == 1
					if nullable {
						nullableCount++
					}
					g.edges = append(g.edges, testEdge{
						from:     u,
						to:       v,
						cell:     cell,
						nullable: nullable,
					})
				}
			}
		}

		rows, refs := g.toRequest()
		if nullableCount > MaxDeferrableEdges {
			if _, err := BuildPlan(rows, refs); !errorIs(err, ErrTooManyDeferrableEdges) {
				t.Fatalf("iter %d: want ErrTooManyDeferrableEdges, got %v", iter, err)
			}
			continue
		}
		checkGraphAgainstOracle(t, g)
	}
}
