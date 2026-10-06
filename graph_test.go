package calib

import (
	"errors"
	"testing"
)

func mustAdd(t *testing.T, g *Graph, c Constraint) {
	t.Helper()
	if err := g.Add(c); err != nil {
		t.Fatalf("Add(%+v) 失败: %v", c, err)
	}
}

func TestPotentialsAndMinIDOrigin(t *testing.T) {
	g := New()
	// 连通组 {5,3,9}：原点应为最小 ID 3，势恒等。
	mustAdd(t, g, Constraint{ID: 1, A: 5, B: 3, T: Transform{Rot: 1, DX: 2, DY: 0}})
	mustAdd(t, g, Constraint{ID: 2, A: 3, B: 9, T: Transform{DX: -1, DY: 4}})

	if root, _ := g.Component(5); root != 3 {
		t.Fatalf("连通组原点 = %d, 期望 3", root)
	}
	if pot, _ := g.Transform(3); !pot.IsIdentity() {
		t.Fatalf("原点势应为恒等, 得到 %+v", pot)
	}
	// value[3] = T1 ∘ value[5]，故 value[5] = T1^{-1}。
	want5 := (Transform{Rot: 1, DX: 2, DY: 0}).Inverse()
	if pot, _ := g.Transform(5); pot != want5 {
		t.Fatalf("pot[5] = %+v, 期望 %+v", pot, want5)
	}
	if pot, _ := g.Transform(9); pot != (Transform{DX: -1, DY: 4}) {
		t.Fatalf("pot[9] = %+v", pot)
	}
	// 另一独立连通组 {7} 与 {5,3,9} 不连通。
	if _, ok := g.Relative(5, 7); ok {
		t.Fatal("跨连通组 Relative 应失败")
	}
	if _, ok := g.Transform(7); ok {
		t.Fatal("未出现的机器人应无势变换")
	}
}

func TestConsistentCycleAccepted(t *testing.T) {
	g := New()
	mustAdd(t, g, Constraint{ID: 1, A: 0, B: 1, T: Transform{DX: 1}})
	mustAdd(t, g, Constraint{ID: 2, A: 1, B: 2, T: Transform{DY: 1}})
	// 与路径复合一致的闭环边：value[2] = (DX:1,DY:1) ∘ value[0]。
	mustAdd(t, g, Constraint{ID: 3, A: 0, B: 2, T: Transform{DX: 1, DY: 1}})
	if len(g.Constraints()) != 3 {
		t.Fatal("一致约束应被接受")
	}
}

func TestContradictionCertificate(t *testing.T) {
	g := New()
	mustAdd(t, g, Constraint{ID: 1, A: 0, B: 1, T: Transform{Rot: 1}})
	mustAdd(t, g, Constraint{ID: 2, A: 1, B: 2, T: Transform{DX: 3}})
	bad := Constraint{ID: 3, A: 0, B: 2, T: Transform{DY: 5}}
	err := g.Add(bad)
	var contra *Contradiction
	if !errors.As(err, &contra) {
		t.Fatalf("应返回 *Contradiction, 得到 %v", err)
	}
	// 证书复合变换非恒等。
	if contra.Composed.IsIdentity() {
		t.Fatal("矛盾证书的复合变换应非恒等")
	}
	// 闭环闭合：每步终点接下一步起点，末步回到首步起点。
	n := len(contra.Cycle)
	if n != 3 {
		t.Fatalf("闭环长度 = %d, 期望 3", n)
	}
	for i, s := range contra.Cycle {
		next := contra.Cycle[(i+1)%n]
		if s.To != next.From {
			t.Fatalf("闭环在第 %d 步断开: %+v -> %+v", i, s, next)
		}
	}
	// 沿闭环逐步复合应等于证书中的复合变换。
	composed := Identity()
	for _, s := range contra.Cycle {
		composed = s.T.Compose(composed)
	}
	if composed != contra.Composed {
		t.Fatalf("逐步复合 %+v != 证书 %+v", composed, contra.Composed)
	}
	// 矛盾约束被拒绝，图保持原状。
	if len(g.Constraints()) != 2 {
		t.Fatal("矛盾约束不应入库")
	}
	if _, ok := g.SnapshotAt(g.Version()); !ok {
		t.Fatal("当前版本快照应存在")
	}
}

func TestSelfLoopContradiction(t *testing.T) {
	g := New()
	mustAdd(t, g, Constraint{ID: 1, A: 0, B: 1, T: Transform{DX: 1}})
	err := g.Add(Constraint{ID: 2, A: 0, B: 0, T: Transform{Rot: 2}})
	var contra *Contradiction
	if !errors.As(err, &contra) {
		t.Fatalf("自环矛求应返回 *Contradiction, 得到 %v", err)
	}
	if len(contra.Cycle) != 1 || contra.Cycle[0].From != 0 || contra.Cycle[0].To != 0 {
		t.Fatalf("自环证书异常: %+v", contra.Cycle)
	}
	// 一致的自环（恒等）应被接受。
	mustAdd(t, g, Constraint{ID: 3, A: 0, B: 0, T: Identity()})
}

func TestDuplicateIDAndRemoveMissing(t *testing.T) {
	g := New()
	mustAdd(t, g, Constraint{ID: 1, A: 0, B: 1, T: Identity()})
	if err := g.Add(Constraint{ID: 1, A: 0, B: 2, T: Identity()}); err == nil {
		t.Fatal("重复 ID 应报错")
	}
	if g.Remove(99) {
		t.Fatal("删除不存在的 ID 应返回 false")
	}
}

func TestRemoveSplitsComponent(t *testing.T) {
	g := New()
	mustAdd(t, g, Constraint{ID: 1, A: 4, B: 2, T: Transform{DX: 1}})
	mustAdd(t, g, Constraint{ID: 2, A: 2, B: 8, T: Transform{DY: 1}})
	if !g.Remove(1) {
		t.Fatal("删除应成功")
	}
	// 顶点 4 不再有任何约束，应从图中消失；{2,8} 以最小 ID 2 为原点。
	if _, ok := g.Component(4); ok {
		t.Fatal("删除后顶点 4 不应存在")
	}
	if root, _ := g.Component(8); root != 2 {
		t.Fatalf("分裂后 8 的组原点应为 2, 得到 %d", root)
	}
	if pot, _ := g.Transform(2); !pot.IsIdentity() {
		t.Fatal("新组原点势应为恒等")
	}
	if _, ok := g.Relative(4, 8); ok {
		t.Fatal("分裂后 4 与 8 不应连通")
	}
}

func TestSnapshotsPreserved(t *testing.T) {
	g := New()
	mustAdd(t, g, Constraint{ID: 1, A: 0, B: 1, T: Transform{DX: 7}}) // 版本 1
	snap1 := g.Snapshot()
	mustAdd(t, g, Constraint{ID: 2, A: 1, B: 2, T: Transform{Rot: 3}}) // 版本 2
	g.Remove(1)                                                        // 版本 3

	if g.Version() != 3 {
		t.Fatalf("版本号 = %d, 期望 3", g.Version())
	}
	// 旧快照内容不随后续增删改变。
	if pot, ok := snap1.Transform(1); !ok || pot != (Transform{DX: 7}) {
		t.Fatalf("旧快照 pot[1] = %+v, ok=%v", pot, ok)
	}
	if _, ok := snap1.Transform(2); ok {
		t.Fatal("旧快照不应包含后加的机器人 2")
	}
	if len(snap1.Constraints()) != 1 {
		t.Fatal("旧快照应只含 1 条约束")
	}
	// 按版本号取历史快照。
	s0, ok := g.SnapshotAt(0)
	if !ok || len(s0.Constraints()) != 0 {
		t.Fatal("版本 0 应为空图")
	}
	s2, ok := g.SnapshotAt(2)
	if !ok || len(s2.Constraints()) != 2 {
		t.Fatal("版本 2 应含 2 条约束")
	}
	if _, ok := g.SnapshotAt(4); ok {
		t.Fatal("超出范围的版本应不存在")
	}
	// 当前版本：约束 1 已删，机器人 0、1 不再出现。
	if _, ok := g.Transform(0); ok {
		t.Fatal("删除约束 1 后机器人 0 应消失")
	}
	// 剩余组 {1,2} 以最小 ID 1 为原点。
	if root, _ := g.Component(2); root != 1 {
		t.Fatalf("机器人 2 的组原点应为 1, 得到 %d", root)
	}
	if pot, _ := g.Transform(2); pot != (Transform{Rot: 3}) {
		t.Fatalf("pot[2] = %+v, 期望 {Rot:3}", pot)
	}
}
