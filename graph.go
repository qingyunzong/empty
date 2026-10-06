// Package calib 提供机器人间相对坐标约束的标定库。
//
// 约束形式为 value[B] = T ∘ value[A]，其中 T 为整数平移与 90 度旋转的
// 复合刚体变换（组合顺序不可交换）。库维护各连通组的势变换，连通组以
// 最小机器人 ID 为原点（势为恒等变换）。新增约束若与现有约束矛盾，
// 拒绝该约束并返回闭环及复合变换证书。约束可按 ID 增删，历史版本以
// 快照形式保留。
package calib

import "fmt"

// Constraint 表示一条相对坐标约束：value[B] = T ∘ value[A]。
type Constraint struct {
	ID int
	A  int
	B  int
	T  Transform
}

// CycleStep 是闭环上的一步：沿约束 ConstraintID 从 From 走到 To，
// 满足 value[To] = T ∘ value[From]。
type CycleStep struct {
	ConstraintID int
	From         int
	To           int
	T            Transform
}

// Contradiction 是矛盾证书：一个闭环及沿环复合的变换。
// 若约束集合一致，复合变换应为恒等；非恒等即矛盾的具体证据。
// 它实现了 error 接口。
type Contradiction struct {
	Cycle    []CycleStep // 闭合路径：首尾相接，终点回到起点
	Composed Transform   // 沿 Cycle 顺序复合的总变换，非恒等
}

func (c *Contradiction) Error() string {
	return fmt.Sprintf("calib: 约束矛盾，闭环长度 %d，复合变换 %+v", len(c.Cycle), c.Composed)
}

// Graph 是约束图，维护势变换与连通组。零值不可用，请用 New 构造。
type Graph struct {
	constraints map[int]Constraint
	adj         map[int]map[int]CycleStep // adj[vertex][constraintID] = 沿该约束离开 vertex 的一步
	pot         map[int]Transform         // 机器人 -> 相对连通组原点的势变换
	comp        map[int]int               // 机器人 -> 连通组原点（组内最小 ID）
	history     []*Snapshot               // history[v] 为版本 v 的快照
}

// New 构造空约束图。
func New() *Graph {
	g := &Graph{
		constraints: make(map[int]Constraint),
		adj:         make(map[int]map[int]CycleStep),
	}
	g.recompute()
	g.record()
	return g
}

// Add 加入约束。若与现有约束矛盾，拒绝加入并返回 *Contradiction
// （含闭环与复合变换证书）；ID 已存在时返回普通错误。
func (g *Graph) Add(c Constraint) error {
	if _, ok := g.constraints[c.ID]; ok {
		return fmt.Errorf("calib: 约束 ID %d 已存在", c.ID)
	}
	if _, okA := g.pot[c.A]; okA {
		if _, okB := g.pot[c.B]; okB && g.comp[c.A] == g.comp[c.B] {
			if contra := g.checkCycle(c); contra != nil {
				return contra
			}
		}
	}
	g.constraints[c.ID] = c
	g.link(c)
	g.recompute()
	g.record()
	return nil
}

// Remove 按 ID 删除约束，返回是否删除成功。
func (g *Graph) Remove(id int) bool {
	c, ok := g.constraints[id]
	if !ok {
		return false
	}
	delete(g.constraints, id)
	delete(g.adj[c.A], c.ID)
	delete(g.adj[c.B], c.ID)
	if len(g.adj[c.A]) == 0 {
		delete(g.adj, c.A)
	}
	if len(g.adj[c.B]) == 0 {
		delete(g.adj, c.B)
	}
	g.recompute()
	g.record()
	return true
}

// Transform 返回机器人 v 相对其连通组原点（组内最小 ID）的势变换。
func (g *Graph) Transform(v int) (Transform, bool) {
	t, ok := g.pot[v]
	return t, ok
}

// Component 返回机器人 v 所在连通组的原点（组内最小 ID）。
func (g *Graph) Component(v int) (int, bool) {
	root, ok := g.comp[v]
	return root, ok
}

// Relative 返回 value[to] ∘ value[from]^{-1}，两点须在同一连通组。
func (g *Graph) Relative(from, to int) (Transform, bool) {
	pf, okF := g.pot[from]
	pt, okT := g.pot[to]
	if !okF || !okT || g.comp[from] != g.comp[to] {
		return Transform{}, false
	}
	return pt.Compose(pf.Inverse()), true
}

// Constraints 返回当前全部约束（按 ID 的副本映射）。
func (g *Graph) Constraints() map[int]Constraint {
	return copyConstraints(g.constraints)
}

// Version 返回当前版本号（每次成功增删加一）。
func (g *Graph) Version() int { return len(g.history) - 1 }

// Snapshot 返回当前版本的不可变快照。
func (g *Graph) Snapshot() *Snapshot { return g.history[len(g.history)-1] }

// SnapshotAt 返回指定历史版本的快照，旧快照在后续增删后保持有效。
func (g *Graph) SnapshotAt(version int) (*Snapshot, bool) {
	if version < 0 || version >= len(g.history) {
		return nil, false
	}
	return g.history[version], true
}

func (g *Graph) link(c Constraint) {
	if g.adj[c.A] == nil {
		g.adj[c.A] = make(map[int]CycleStep)
	}
	if g.adj[c.B] == nil {
		g.adj[c.B] = make(map[int]CycleStep)
	}
	g.adj[c.A][c.ID] = CycleStep{ConstraintID: c.ID, From: c.A, To: c.B, T: c.T}
	g.adj[c.B][c.ID] = CycleStep{ConstraintID: c.ID, From: c.B, To: c.A, T: c.T.Inverse()}
}

// checkCycle 在 A、B 已连通时检测新约束是否矛盾。
// 证书闭环：从 A 沿现有路径到 B，再沿新约束的逆向从 B 回到 A。
func (g *Graph) checkCycle(c Constraint) *Contradiction {
	steps := g.path(c.A, c.B)
	if steps == nil {
		return nil
	}
	steps = append(steps, CycleStep{ConstraintID: c.ID, From: c.B, To: c.A, T: c.T.Inverse()})
	composed := Identity()
	for _, s := range steps {
		composed = s.T.Compose(composed)
	}
	if composed.IsIdentity() {
		return nil
	}
	return &Contradiction{Cycle: steps, Composed: composed}
}

// path 用 BFS 求 from 到 to 的一条路径，返回沿路径的有向步骤。
// from == to 时返回空路径。不连通时返回 nil。
func (g *Graph) path(from, to int) []CycleStep {
	if from == to {
		return []CycleStep{}
	}
	prev := map[int]CycleStep{from: {ConstraintID: -1, From: -1, To: from}}
	queue := []int{from}
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		if v == to {
			break
		}
		for _, step := range g.adj[v] {
			if _, seen := prev[step.To]; !seen {
				prev[step.To] = step
				queue = append(queue, step.To)
			}
		}
	}
	if _, ok := prev[to]; !ok {
		return nil
	}
	var rev []CycleStep
	for v := to; v != from; {
		step := prev[v]
		rev = append(rev, step)
		v = step.From
	}
	steps := make([]CycleStep, len(rev))
	for i, s := range rev {
		steps[len(rev)-1-i] = s
	}
	return steps
}

// recompute 重建全部连通组与势变换。由于矛盾约束在加入时被拒绝，
// 存储的约束集合始终一致，势变换与 BFS 顺序无关。
func (g *Graph) recompute() {
	g.pot = make(map[int]Transform)
	g.comp = make(map[int]int)
	visited := make(map[int]bool)
	for v := range g.adj {
		if visited[v] {
			continue
		}
		// 收集连通组成员并求最小 ID 作为原点。
		members := []int{v}
		visited[v] = true
		root := v
		for i := 0; i < len(members); i++ {
			for _, step := range g.adj[members[i]] {
				if !visited[step.To] {
					visited[step.To] = true
					members = append(members, step.To)
					if step.To < root {
						root = step.To
					}
				}
			}
		}
		// 从原点 BFS 赋势。
		g.pot[root] = Identity()
		g.comp[root] = root
		queue := []int{root}
		for len(queue) > 0 {
			x := queue[0]
			queue = queue[1:]
			for _, step := range g.adj[x] {
				if _, done := g.comp[step.To]; !done {
					g.pot[step.To] = step.T.Compose(g.pot[x])
					g.comp[step.To] = root
					queue = append(queue, step.To)
				}
			}
		}
	}
}

func (g *Graph) record() {
	g.history = append(g.history, &Snapshot{
		version:     len(g.history),
		constraints: copyConstraints(g.constraints),
		pot:         copyMap(g.pot),
		comp:        copyMap(g.comp),
	})
}

func copyConstraints(m map[int]Constraint) map[int]Constraint {
	out := make(map[int]Constraint, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func copyMap[V any](m map[int]V) map[int]V {
	out := make(map[int]V, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
