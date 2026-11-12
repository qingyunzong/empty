package dataeng

import (
	"container/heap"
	"errors"
	"fmt"
	"sort"
)

// MaxDeferrableEdges 是一次规划允许的可延迟（可空）外键边数量上限。
const MaxDeferrableEdges = 20

// 规划阶段返回的典型错误。调用方可用 errors.Is 判定类别。
var (
	// ErrInvalidRequest 表示输入结构本身不合法（空 ID、重复行、重复字段等）。
	ErrInvalidRequest = errors.New("dataeng: invalid load plan request")
	// ErrUnresolvedReference 表示某条非 null 外键指向了输入中不存在的行。
	ErrUnresolvedReference = errors.New("dataeng: unresolved foreign key reference")
	// ErrNonDeferrableCycle 表示仅由非可空外键构成的环，这类边不允许延迟，
	// 因此该数据集无法在当前输入下恢复。
	ErrNonDeferrableCycle = errors.New("dataeng: non-deferrable foreign key cycle")
	// ErrTooManyDeferrableEdges 表示候选延迟边数量超过 MaxDeferrableEdges。
	ErrTooManyDeferrableEdges = errors.New("dataeng: too many deferrable foreign key edges")
)

// PlanError 携带错误类别与定位上下文，便于恢复宿主记录日志。
type PlanError struct {
	Op  string // 触发错误的阶段
	Err error  // 包装的哨兵错误
	Msg string // 人可读的定位信息
}

func (e *PlanError) Error() string {
	if e.Msg == "" {
		return e.Op + ": " + e.Err.Error()
	}
	return e.Op + ": " + e.Err.Error() + ": " + e.Msg
}

func (e *PlanError) Unwrap() error { return e.Err }

func fail(op string, err error, format string, args ...any) error {
	return &PlanError{Op: op, Err: err, Msg: fmt.Sprintf(format, args...)}
}

// RowRef 用表 ID 与行主键共同唯一定位一条行。
type RowRef struct {
	TableID string
	RowID   string
}

func (r RowRef) less(other RowRef) bool {
	if r.TableID != other.TableID {
		return r.TableID < other.TableID
	}
	return r.RowID < other.RowID
}

// Reference 描述一条外键。空值外键（Nullable 且 Target 为 nil）不构成依赖边，
// 装载时该行字段保持 null；非 null 外键始终指向一条确定的行。
type Reference struct {
	Source   RowRef
	FieldID  string
	Target   *RowRef
	Nullable bool // 为 true 时该外键允许延迟（先置 null 再补写）
}

// Backfill 描述一条补写操作：在 Source 行已经装载后，把 FieldID 字段写回 Target。
type Backfill struct {
	Source  RowRef
	FieldID string
	Target  RowRef
}

// Plan 是装载规划结果。
type Plan struct {
	// LoadOrder 是全部输入行的装载顺序；同一时刻有多条就绪行时，
	// 按表 ID 再按行 ID 的字节序择优。
	LoadOrder []RowRef
	// Backfills 是需要在对应行装载之后执行的补写操作，
	// 按表 ID、行 ID、字段 ID 的字节序排列。
	Backfills []Backfill
	// DeferredFields 是本次被临时置 null 的外键单元格，
	// 按表 ID、行 ID、字段 ID 的字节序排列。
	DeferredFields []Reference
}

// edge 是行级依赖图中的一条边：from 行的 fieldID 外键指向 to 行。
type edge struct {
	index    int // 在 validateAndBuild 输出边列表中的下标，用于稳定去重
	from     int
	to       int
	fieldID  string
	nullable bool
}

type planner struct {
	rows []RowRef
	idx  map[RowRef]int
}

// BuildPlan 校验输入并产出装载计划。
//
// 依赖按行而非按表建立：每条非 null 外键都是一条从源行指向目标行的有向边。
// 非可空外键属于固定边，任何情况下都不能延迟；可空外键是候选延迟边，
// 数量不超过 MaxDeferrableEdges。存在环时，求需要临时置 null 的字段数最少
// 的方案；若并列，选取延迟单元格的 (表 ID, 行 ID, 字段 ID) 序列字节序最小者。
func BuildPlan(rows []RowRef, refs []Reference) (*Plan, error) {
	p, edges, err := validateAndBuild(rows, refs)
	if err != nil {
		return nil, err
	}

	fixed := make([][]int, len(p.rows))
	var candidates []edge
	for _, e := range edges {
		if e.nullable {
			candidates = append(candidates, e)
		} else {
			fixed[e.from] = append(fixed[e.from], e.to)
		}
	}
	if len(candidates) > MaxDeferrableEdges {
		return nil, fail("validate", ErrTooManyDeferrableEdges,
			"deferrable edges=%d limit=%d", len(candidates), MaxDeferrableEdges)
	}

	// 非可空边自身成环则无法恢复：这类边不允许延迟。
	if !digraphAcyclic(fixed, len(p.rows)) {
		return nil, fail("analyze", ErrNonDeferrableCycle,
			"cycle consists solely of non-nullable foreign keys")
	}

	deferred := chooseMinimumDeferrals(p, fixed, candidates)

	// 去掉被延迟的候选边后，全图必为 DAG。装载邻接表按“目标行 -> 源行”建边，
	// 这样被引用的行先出队，引用它的行在其入度（待满足依赖数）清零后才可装载。
	active := make([][]int, len(p.rows))
	deferredSet := make(map[int]bool, len(deferred))
	for _, e := range deferred {
		deferredSet[e.index] = true
	}
	for idx, e := range edges {
		if deferredSet[idx] {
			continue
		}
		active[e.to] = append(active[e.to], e.from)
	}

	order, err := topoOrder(p, active)
	if err != nil {
		return nil, err
	}

	backfills := make([]Backfill, 0, len(deferred))
	deferredRefs := make([]Reference, 0, len(deferred))
	for _, e := range deferred {
		source := p.rows[e.from]
		target := p.rows[e.to]
		t := target
		backfills = append(backfills, Backfill{Source: source, FieldID: e.fieldID, Target: target})
		deferredRefs = append(deferredRefs, Reference{
			Source:   source,
			FieldID:  e.fieldID,
			Target:   &t,
			Nullable: true,
		})
	}
	sortBackfills(backfills)
	sortReferences(deferredRefs)

	return &Plan{
		LoadOrder:      order,
		Backfills:      backfills,
		DeferredFields: deferredRefs,
	}, nil
}

// validateAndBuild 完成主键唯一性、单元格唯一性以及非 null 引用存在性校验，
// 并把输入转换为内部行级边列表。
func validateAndBuild(rows []RowRef, refs []Reference) (*planner, []edge, error) {
	if len(rows) == 0 {
		if len(refs) == 0 {
			return &planner{rows: nil, idx: map[RowRef]int{}}, nil, nil
		}
		return nil, nil, fail("validate", ErrInvalidRequest, "references present but no rows supplied")
	}

	p := &planner{rows: make([]RowRef, 0, len(rows)), idx: make(map[RowRef]int, len(rows))}
	for i, row := range rows {
		if row.TableID == "" || row.RowID == "" {
			return nil, nil, fail("validate", ErrInvalidRequest,
				"rows[%d] has empty table or row id", i)
		}
		if _, dup := p.idx[row]; dup {
			return nil, nil, fail("validate", ErrInvalidRequest,
				"duplicate primary key table=%q row=%q", row.TableID, row.RowID)
		}
		p.idx[row] = len(p.rows)
		p.rows = append(p.rows, row)
	}

	type cell struct {
		row     RowRef
		fieldID string
	}
	seenCell := make(map[cell]bool, len(refs))
	edges := make([]edge, 0, len(refs))
	for i, ref := range refs {
		if ref.Source.TableID == "" || ref.Source.RowID == "" || ref.FieldID == "" {
			return nil, nil, fail("validate", ErrInvalidRequest,
				"refs[%d] has empty source table, row or field id", i)
		}
		key := cell{row: ref.Source, fieldID: ref.FieldID}
		if seenCell[key] {
			return nil, nil, fail("validate", ErrInvalidRequest,
				"duplicate foreign key cell table=%q row=%q field=%q",
				ref.Source.TableID, ref.Source.RowID, ref.FieldID)
		}
		seenCell[key] = true

		from, ok := p.idx[ref.Source]
		if !ok {
			return nil, nil, fail("validate", ErrUnresolvedReference,
				"source row not in row list table=%q row=%q",
				ref.Source.TableID, ref.Source.RowID)
		}
		if ref.Target == nil {
			if !ref.Nullable {
				return nil, nil, fail("validate", ErrInvalidRequest,
					"non-nullable foreign key table=%q row=%q field=%q has null target",
					ref.Source.TableID, ref.Source.RowID, ref.FieldID)
			}
			// 空值外键不形成依赖边，装载时保持 null。
			continue
		}
		to, ok := p.idx[*ref.Target]
		if !ok {
			return nil, nil, fail("validate", ErrUnresolvedReference,
				"target row missing table=%q row=%q (from table=%q row=%q field=%q)",
				ref.Target.TableID, ref.Target.RowID,
				ref.Source.TableID, ref.Source.RowID, ref.FieldID)
		}
		edges = append(edges, edge{
			index:    len(edges),
			from:     from,
			to:       to,
			fieldID:  ref.FieldID,
			nullable: ref.Nullable,
		})
	}
	return p, edges, nil
}

// edgeLess 按 (源表 ID, 源行 ID, 字段 ID) 的字节序比较两条候选边，
// 用于并列方案的字典序裁决。
func edgeLess(p *planner, a, b edge) bool {
	ra, rb := p.rows[a.from], p.rows[b.from]
	if ra.TableID != rb.TableID {
		return ra.TableID < rb.TableID
	}
	if ra.RowID != rb.RowID {
		return ra.RowID < rb.RowID
	}
	return a.fieldID < b.fieldID
}

// chooseMinimumDeferrals 返回置 null 字段数最少的候选边集合；
// 并列时取 (表 ID, 行 ID, 字段 ID) 序列字节序最小的方案。
func chooseMinimumDeferrals(p *planner, fixed [][]int, candidates []edge) []edge {
	if len(candidates) == 0 {
		return nil
	}

	// 候选边按其所在外键单元格的字节序排列，保证字典序并列裁决可直接比较子集。
	sorted := append([]edge(nil), candidates...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return edgeLess(p, sorted[i], sorted[j])
	})

	m := len(sorted)
	endpoints := make(map[int]bool, 2*m)
	for _, e := range sorted {
		endpoints[e.from] = true
		endpoints[e.to] = true
	}

	// fixedReach[a][b]：仅沿固定（非可空）边，a 是否可达 b（含 a==b 的 0 长度路径）。
	fixedReach := reachability(fixed, endpoints)

	// 候选边依赖图 D：顶点是候选边。若沿“固定边 + 已保留候选边”从候选边 i 的
	// 目标能到达候选边 j 的源，则存在弧 i->j。全图的环与 D 的环一一对应
	// （自环候选边同理），因而“最少延迟边”等价于 D 上的最小反馈顶点集。
	dep := make([][]int, m)
	for i := 0; i < m; i++ {
		for j := 0; j < m; j++ {
			// i==j 且候选边两端不同行时，零长度路径不构成环（from!=to）；
			// 行级自环（from==to）会被含自身的可达矩阵命中。混合环则通过
			// 非平凡固定路径命中，两类情形都由这一条查询统一覆盖。
			if fixedReach[sorted[i].to][sorted[j].from] {
				dep[i] = append(dep[i], j)
			}
		}
	}

	bestMask := minimumFeedbackVertexSet(dep)

	var deferred []edge
	for i := 0; i < m; i++ {
		if bestMask&(1<<uint(i)) != 0 {
			deferred = append(deferred, sorted[i])
		}
	}
	return deferred
}

// minimumFeedbackVertexSet 在至多 MaxDeferrableEdges 个顶点的依赖图上，
// 按基数递增枚举反馈顶点集；同基数下组合按下标字典序产生，配合候选边的
// 字节序排列即得到字节序最优解。返回值第 i 位为 1 表示候选边 i 被延迟。
func minimumFeedbackVertexSet(dep [][]int) uint32 {
	m := len(dep)
	all := uint32(1)<<uint(m) - 1
	for k := 0; k <= m; k++ {
		found := ^uint32(0)
		// eachCombination 按下标字典序产出组合；候选边已按字节序排列，
		// 因此同一基数下第一个可行解就是字节序列字典序最小的延迟方案。
		eachCombination(m, k, func(combo []int) bool {
			var removed uint32
			for _, idx := range combo {
				removed |= 1 << uint(idx)
			}
			if inducedAcyclic(dep, all^removed) {
				found = removed
				return false
			}
			return true
		})
		if found != ^uint32(0) {
			return found
		}
	}
	return all
}

// eachCombination 按字典序枚举 [0,n) 中大小为 k 的所有组合，
// fn 返回 false 时提前终止。
func eachCombination(n, k int, fn func(combo []int) bool) {
	if k == 0 {
		fn(nil)
		return
	}
	if k > n {
		return
	}
	combo := make([]int, k)
	for i := range combo {
		combo[i] = i
	}
	for {
		if !fn(combo) {
			return
		}
		// 定位最右可递增位置。
		i := k - 1
		for i >= 0 && combo[i] == n-k+i {
			i--
		}
		if i < 0 {
			return
		}
		combo[i]++
		for j := i + 1; j < k; j++ {
			combo[j] = combo[j-1] + 1
		}
	}
}

// inducedAcyclic 判断顶点掩码 mask 诱导的子图是否无环。
// 自环（依赖图顶点指向自身）在入度统计中被计入，Kahn 无法清空即判定有环。
func inducedAcyclic(dep [][]int, mask uint32) bool {
	indeg := make([]int, len(dep))
	active := 0
	for v := 0; v < len(dep); v++ {
		if mask&(1<<uint(v)) == 0 {
			continue
		}
		active++
		for _, w := range dep[v] {
			if v == w {
				// 自环必然成环，直接判定。
				return false
			}
			if mask&(1<<uint(w)) != 0 {
				indeg[w]++
			}
		}
	}
	queue := make([]int, 0, active)
	for v := 0; v < len(dep); v++ {
		if mask&(1<<uint(v)) != 0 && indeg[v] == 0 {
			queue = append(queue, v)
		}
	}
	visited := 0
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		visited++
		for _, w := range dep[v] {
			if mask&(1<<uint(w)) == 0 {
				continue
			}
			indeg[w]--
			if indeg[w] == 0 {
				queue = append(queue, w)
			}
		}
	}
	return visited == active
}

// reachability 在固定边图上计算可达矩阵（含 0 长度自身可达），
// 只对 vertices 中的起点做 BFS，足以覆盖候选边端点之间的查询。
func reachability(adj [][]int, vertices map[int]bool) map[int]map[int]bool {
	reach := make(map[int]map[int]bool, len(vertices))
	for start := range vertices {
		seen := map[int]bool{start: true}
		queue := []int{start}
		for len(queue) > 0 {
			cur := queue[0]
			queue = queue[1:]
			if cur >= len(adj) {
				continue
			}
			for _, next := range adj[cur] {
				if !seen[next] {
					seen[next] = true
					queue = append(queue, next)
				}
			}
		}
		reach[start] = seen
	}
	return reach
}

// digraphAcyclic 用 Kahn 算法判断邻接表表示的有向图是否无环。
func digraphAcyclic(adj [][]int, n int) bool {
	indeg := make([]int, n)
	for u := range adj {
		for _, v := range adj[u] {
			indeg[v]++
		}
	}
	queue := make([]int, 0, n)
	for v := 0; v < n; v++ {
		if indeg[v] == 0 {
			queue = append(queue, v)
		}
	}
	visited := 0
	for len(queue) > 0 {
		u := queue[0]
		queue = queue[1:]
		visited++
		for _, v := range adj[u] {
			indeg[v]--
			if indeg[v] == 0 {
				queue = append(queue, v)
			}
		}
	}
	return visited == n
}

// readyHeap 使就绪行始终按表 ID、再按行 ID 的字节序出队。
type readyHeap struct {
	p    *planner
	rows []int
}

func (h readyHeap) Len() int { return len(h.rows) }

func (h readyHeap) Less(i, j int) bool {
	return h.p.rows[h.rows[i]].less(h.p.rows[h.rows[j]])
}

func (h readyHeap) Swap(i, j int) { h.rows[i], h.rows[j] = h.rows[j], h.rows[i] }

func (h *readyHeap) Push(x any) { h.rows = append(h.rows, x.(int)) }

func (h *readyHeap) Pop() any {
	old := h.rows
	last := old[len(old)-1]
	h.rows = old[:len(old)-1]
	return last
}

// topoOrder 在 DAG 上做确定性拓扑排序：每条就绪行中字节序最小者先装载。
func topoOrder(p *planner, adj [][]int) ([]RowRef, error) {
	n := len(p.rows)
	indeg := make([]int, n)
	for u := range adj {
		for _, v := range adj[u] {
			indeg[v]++
		}
	}
	h := &readyHeap{p: p}
	for v := 0; v < n; v++ {
		if indeg[v] == 0 {
			heap.Push(h, v)
		}
	}

	order := make([]RowRef, 0, n)
	for h.Len() > 0 {
		u := heap.Pop(h).(int)
		order = append(order, p.rows[u])
		for _, v := range adj[u] {
			indeg[v]--
			if indeg[v] == 0 {
				heap.Push(h, v)
			}
		}
	}
	if len(order) != n {
		return nil, fail("plan", ErrNonDeferrableCycle,
			"residual cycle after deferral (internal invariant violation)")
	}
	return order, nil
}

// sortBackfills 按 (源表 ID, 源行 ID, 字段 ID) 字节序排列补写操作。
func sortBackfills(items []Backfill) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if !a.Source.equal(b.Source) {
			return a.Source.less(b.Source)
		}
		return a.FieldID < b.FieldID
	})
}

// sortReferences 按 (源表 ID, 源行 ID, 字段 ID) 字节序排列延迟字段。
func sortReferences(items []Reference) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if !a.Source.equal(b.Source) {
			return a.Source.less(b.Source)
		}
		return a.FieldID < b.FieldID
	})
}

func (r RowRef) equal(other RowRef) bool {
	return r.TableID == other.TableID && r.RowID == other.RowID
}
