package calib

import (
	"errors"
	"math/rand"
	"testing"
)

// reference 是独立参考实现：对给定约束集合做全路径 BFS，
// 从各连通组最小 ID 原点出发复合势变换。
func reference(cs map[int]Constraint) (pot, comp map[int]Transform, root map[int]int) {
	adj := make(map[int]map[int]Transform)
	for _, c := range cs {
		if adj[c.A] == nil {
			adj[c.A] = make(map[int]Transform)
		}
		if adj[c.B] == nil {
			adj[c.B] = make(map[int]Transform)
		}
		adj[c.A][c.B] = c.T
		adj[c.B][c.A] = c.T.Inverse()
	}
	pot = make(map[int]Transform)
	root = make(map[int]int)
	visited := make(map[int]bool)
	for v := range adj {
		if visited[v] {
			continue
		}
		members := []int{v}
		visited[v] = true
		min := v
		for i := 0; i < len(members); i++ {
			for w := range adj[members[i]] {
				if !visited[w] {
					visited[w] = true
					members = append(members, w)
					if w < min {
						min = w
					}
				}
			}
		}
		pot[min] = Identity()
		root[min] = min
		queue := []int{min}
		for len(queue) > 0 {
			x := queue[0]
			queue = queue[1:]
			for w, t := range adj[x] {
				if _, done := root[w]; !done {
					pot[w] = t.Compose(pot[x])
					root[w] = min
					queue = append(queue, w)
				}
			}
		}
	}
	return pot, comp, root
}

func checkAgainstReference(t *testing.T, g *Graph, cs map[int]Constraint, ctx string) {
	t.Helper()
	refPot, _, refRoot := reference(cs)
	// 顶点集合一致。
	if len(refPot) != len(g.pot) {
		t.Fatalf("%s: 顶点数 %d != 参考 %d", ctx, len(g.pot), len(refPot))
	}
	for v, want := range refPot {
		got, ok := g.Transform(v)
		if !ok {
			t.Fatalf("%s: 机器人 %d 缺少势变换", ctx, v)
		}
		if got != want {
			t.Fatalf("%s: pot[%d] = %+v, 参考 %+v", ctx, v, got, want)
		}
		if root, _ := g.Component(v); root != refRoot[v] {
			t.Fatalf("%s: comp[%d] = %d, 参考 %d", ctx, v, root, refRoot[v])
		}
		// 原点势必为恒等。
		if refRoot[v] == v && !got.IsIdentity() {
			t.Fatalf("%s: 原点 %d 的势应恒等, 得到 %+v", ctx, v, got)
		}
	}
	// 同组任意两点间的 Relative 与参考势一致。
	for a := range refPot {
		for b := range refPot {
			rel, ok := g.Relative(a, b)
			if refRoot[a] != refRoot[b] {
				if ok {
					t.Fatalf("%s: 跨组 Relative(%d,%d) 应失败", ctx, a, b)
				}
				continue
			}
			want := refPot[b].Compose(refPot[a].Inverse())
			if !ok || rel != want {
				t.Fatalf("%s: Relative(%d,%d) = %+v,%v; 参考 %+v", ctx, a, b, rel, ok, want)
			}
		}
	}
}

// verifyContradiction 独立核验矛盾证书：闭环闭合、逐步复合等于证书值、
// 证书非恒等，且与参考势推出的闭环误差一致。
func verifyContradiction(t *testing.T, contra *Contradiction, cs map[int]Constraint, bad Constraint) {
	t.Helper()
	n := len(contra.Cycle)
	if n == 0 {
		t.Fatal("证书闭环为空")
	}
	for i, s := range contra.Cycle {
		if s.To != contra.Cycle[(i+1)%n].From {
			t.Fatalf("闭环在第 %d 步断开", i)
		}
	}
	composed := Identity()
	for _, s := range contra.Cycle {
		composed = s.T.Compose(composed)
	}
	if composed != contra.Composed {
		t.Fatalf("逐步复合 %+v != 证书 %+v", composed, contra.Composed)
	}
	if contra.Composed.IsIdentity() {
		t.Fatal("矛盾证书复合变换应非恒等")
	}
	// 与参考实现交叉核验：证书应等于 bad.T^{-1} ∘ pot[B] ∘ pot[A]^{-1}。
	refPot, _, _ := reference(cs)
	want := bad.T.Inverse().Compose(refPot[bad.B].Compose(refPot[bad.A].Inverse()))
	if contra.Composed != want {
		t.Fatalf("证书 %+v != 参考闭环误差 %+v", contra.Composed, want)
	}
}

func TestRandomGraphAgainstReference(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	g := New()
	live := make(map[int]Constraint) // 当前应存活的约束
	var ids []int                    // 存活约束 ID
	var history []map[int]Constraint // 每个版本的约束集合
	history = append(history, map[int]Constraint{})
	nextID := 0

	checkAgainstReference(t, g, live, "初始")

	for op := 0; op < 3000; op++ {
		ctx := func() string {
			return "op " + string(rune('0'+op%10))
		}
		_ = ctx
		mutated := false
		if len(live) == 0 || rng.Intn(3) > 0 {
			// 随机新增：小顶点池促使连通与闭环。
			c := Constraint{
				ID: nextID,
				A:  rng.Intn(12),
				B:  rng.Intn(12),
				T: Transform{
					Rot: rng.Intn(4),
					DX:  rng.Intn(7) - 3,
					DY:  rng.Intn(7) - 3,
				},
			}
			nextID++
			err := g.Add(c)
			var contra *Contradiction
			switch {
			case errors.As(err, &contra):
				verifyContradiction(t, contra, live, c)
			case err != nil:
				t.Fatalf("Add 返回意外错误: %v", err)
			default:
				live[c.ID] = c
				ids = append(ids, c.ID)
				mutated = true
			}
		} else {
			// 随机删除。
			i := rng.Intn(len(ids))
			id := ids[i]
			ids = append(ids[:i], ids[i+1:]...)
			if !g.Remove(id) {
				t.Fatalf("Remove(%d) 应成功", id)
			}
			delete(live, id)
			mutated = true
		}

		if mutated {
			snap := map[int]Constraint{}
			for k, v := range live {
				snap[k] = v
			}
			history = append(history, snap)
		}

		// 全路径势变换参考核验。
		checkAgainstReference(t, g, live, "当前图")
		if g.Version() != len(history)-1 {
			t.Fatalf("版本号 %d != 历史长度 %d", g.Version(), len(history)-1)
		}

		// 抽查一个旧版本快照：内容须与当时一致且未被后续修改。
		v := rng.Intn(len(history))
		old, ok := g.SnapshotAt(v)
		if !ok {
			t.Fatalf("版本 %d 快照应存在", v)
		}
		if old.Version() != v {
			t.Fatalf("快照版本 %d != %d", old.Version(), v)
		}
		refPot, _, refRoot := reference(history[v])
		if len(old.Constraints()) != len(history[v]) {
			t.Fatalf("版本 %d 快照约束数不符", v)
		}
		for vtx, want := range refPot {
			got, ok := old.Transform(vtx)
			if !ok || got != want {
				t.Fatalf("版本 %d 快照 pot[%d] = %+v,%v; 参考 %+v", v, vtx, got, ok, want)
			}
			if root, _ := old.Component(vtx); root != refRoot[vtx] {
				t.Fatalf("版本 %d 快照 comp[%d] 不符", v, vtx)
			}
		}
	}
}
