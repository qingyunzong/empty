package ratiograph_test

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"

	"ratiograph"
)

func mustApply(t *testing.T, g *ratiograph.Graph, ops ...ratiograph.Op) *ratiograph.Solution {
	t.Helper()
	sol, cert, err := g.Apply(ops...)
	if err != nil {
		t.Fatalf("Apply returned error: %v", err)
	}
	if cert != nil {
		t.Fatalf("Apply returned unexpected certificate: %v", cert)
	}
	return sol
}

func componentOf(t *testing.T, sol *ratiograph.Solution, node string) ratiograph.Component {
	t.Helper()
	for _, c := range sol.Components {
		for _, n := range c.Nodes {
			if n == node {
				return c
			}
		}
	}
	t.Fatalf("node %q not in any component", node)
	return ratiograph.Component{}
}

func checkVector(t *testing.T, c ratiograph.Component, wantNodes []string, wantVals ...int64) {
	t.Helper()
	if len(c.Nodes) != len(wantNodes) {
		t.Fatalf("component nodes = %v, want %v", c.Nodes, wantNodes)
	}
	for i := range wantNodes {
		if c.Nodes[i] != wantNodes[i] || c.Values[i].Cmp(big.NewInt(wantVals[i])) != 0 {
			t.Fatalf("component = %v/%v, want %v/%v", c.Nodes, c.Values, wantNodes, wantVals)
		}
	}
}

func TestConsistentComponentVector(t *testing.T) {
	g := ratiograph.New()
	sol := mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)),
		ratiograph.AddOp(ratiograph.NewEdge("b", "c", 2, 3)),
	)
	checkVector(t, componentOf(t, sol, "a"), []string{"a", "b", "c"}, 1, 2, 3)
	if !sol.Satisfies(g) {
		t.Fatal("solution does not satisfy graph edges")
	}
}

func TestReducedVectorLcmGcd(t *testing.T) {
	g := ratiograph.New()
	sol := mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 6, 35)),
		ratiograph.AddOp(ratiograph.NewEdge("b", "c", 14, 15)),
	)
	// 势能 1, 35/6, 25/4 -> 乘 lcm(1,6,4)=12 -> 12,70,75，gcd=1
	checkVector(t, componentOf(t, sol, "a"), []string{"a", "b", "c"}, 12, 70, 75)
}

func TestVectorReducedByGcd(t *testing.T) {
	g := ratiograph.New()
	// x/y = 2/4 应约简为 1:2 而非 2:4
	sol := mustApply(t, g, ratiograph.AddOp(ratiograph.NewEdge("x", "y", 2, 4)))
	checkVector(t, componentOf(t, sol, "x"), []string{"x", "y"}, 1, 2)
}

func TestMultipleComponents(t *testing.T) {
	g := ratiograph.New()
	sol := mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 3, 1)),
		ratiograph.AddOp(ratiograph.NewEdge("p", "q", 1, 5)),
	)
	if len(sol.Components) != 2 {
		t.Fatalf("got %d components, want 2", len(sol.Components))
	}
	checkVector(t, componentOf(t, sol, "a"), []string{"a", "b"}, 3, 1)
	checkVector(t, componentOf(t, sol, "p"), []string{"p", "q"}, 1, 5)
}

func TestInconsistencyCertificate(t *testing.T) {
	g := ratiograph.New()
	mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)),
		ratiograph.AddOp(ratiograph.NewEdge("b", "c", 1, 3)),
	)
	// a/c 由路径推出为 1/6，加入 1/5 必冲突
	_, cert, err := g.Apply(ratiograph.AddOp(ratiograph.NewEdge("a", "c", 1, 5)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cert == nil {
		t.Fatal("expected inconsistency certificate")
	}
	if !cert.Verify() {
		t.Fatalf("certificate fails structural verification: %v", cert)
	}
	if cert.Product.Cmp(big.NewRat(1, 1)) == 0 {
		t.Fatalf("certificate product must differ from 1, got %v", cert.Product)
	}
	// 原子性：冲突批不落地
	if g.EdgeCount() != 2 || g.HasEdge("a", "c") {
		t.Fatal("graph mutated despite inconsistency")
	}
}

func TestAtomicBatchRollbackOnConflict(t *testing.T) {
	g := ratiograph.New()
	mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)),
		ratiograph.AddOp(ratiograph.NewEdge("b", "c", 1, 3)),
	)
	// 批内第一条合法，第二条制造冲突 -> 整批回滚
	_, cert, err := g.Apply(
		ratiograph.AddOp(ratiograph.NewEdge("c", "d", 4, 1)),
		ratiograph.AddOp(ratiograph.NewEdge("a", "c", 7, 1)),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cert == nil || !cert.Verify() {
		t.Fatalf("expected valid certificate, got %v", cert)
	}
	if g.EdgeCount() != 2 || !g.HasEdge("a", "b") || g.HasEdge("c", "d") || g.HasEdge("a", "c") {
		t.Fatal("batch not atomic: graph partially mutated")
	}
}

func TestAtomicBatchRollbackOnInvalidOp(t *testing.T) {
	g := ratiograph.New()
	mustApply(t, g, ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)))

	if _, _, err := g.Apply(
		ratiograph.AddOp(ratiograph.NewEdge("c", "d", 1, 1)),
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 9, 9)), // 重复边
	); err == nil {
		t.Fatal("expected duplicate-edge error")
	}
	if _, _, err := g.Apply(ratiograph.RemoveOp("a", "zzz")); err == nil {
		t.Fatal("expected missing-edge error")
	}
	if _, _, err := g.Apply(ratiograph.AddOp(ratiograph.Edge{U: "a", V: "e", Ratio: big.NewRat(-1, 2)})); err == nil {
		t.Fatal("expected non-positive-ratio error")
	}
	if g.EdgeCount() != 1 || g.HasEdge("c", "d") {
		t.Fatal("graph mutated despite invalid batch")
	}
}

func TestBatchRemoveSplitsComponent(t *testing.T) {
	g := ratiograph.New()
	mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)),
		ratiograph.AddOp(ratiograph.NewEdge("b", "c", 2, 3)),
		ratiograph.AddOp(ratiograph.NewEdge("c", "d", 3, 5)),
	)
	sol := mustApply(t, g, ratiograph.RemoveOp("b", "c"))
	if len(sol.Components) != 2 {
		t.Fatalf("got %d components, want 2", len(sol.Components))
	}
	checkVector(t, componentOf(t, sol, "a"), []string{"a", "b"}, 1, 2)
	checkVector(t, componentOf(t, sol, "c"), []string{"c", "d"}, 3, 5)
	if _, ok := sol.Value("zzz"); ok {
		t.Fatal("unknown node should have no value")
	}
}

func TestBatchAddMergesComponents(t *testing.T) {
	g := ratiograph.New()
	mustApply(t, g,
		ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)),
		ratiograph.AddOp(ratiograph.NewEdge("c", "d", 1, 3)),
	)
	sol := mustApply(t, g, ratiograph.AddOp(ratiograph.NewEdge("b", "c", 1, 1)))
	// a:b=1:2, c:d=1:3, b=c -> a:b:c:d = 1:2:2:6
	checkVector(t, componentOf(t, sol, "a"), []string{"a", "b", "c", "d"}, 1, 2, 2, 6)
	if !sol.Satisfies(g) {
		t.Fatal("solution does not satisfy graph edges")
	}
}

func TestSelfLoop(t *testing.T) {
	g := ratiograph.New()
	// 恒等自环是无约束 no-op
	if _, cert, err := g.Apply(ratiograph.AddOp(ratiograph.NewEdge("a", "a", 1, 1))); err != nil || cert != nil {
		t.Fatalf("identity self-loop: cert=%v err=%v", cert, err)
	}
	// 非 1 自环自身即证书
	_, cert, err := g.Apply(ratiograph.AddOp(ratiograph.NewEdge("a", "a", 2, 1)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cert == nil || !cert.Verify() || cert.Product.Cmp(big.NewRat(2, 1)) != 0 {
		t.Fatalf("bad self-loop certificate: %v", cert)
	}
	if g.EdgeCount() != 0 {
		t.Fatal("graph mutated by rejected self-loops")
	}
}

// TestRandomConsistentGraph 随机生成一组“真实”赋值，按赋值生成一致边集，
// 核验解与赋值成比例，再验证注入一条冲突边必产生有效证书且图不变。
func TestRandomConsistentGraph(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 50; trial++ {
		n := 2 + rng.Intn(12)
		names := make([]string, n)
		assign := make([]*big.Rat, n) // 真实赋值
		for i := range names {
			names[i] = fmt.Sprintf("v%d", i)
			assign[i] = big.NewRat(int64(1+rng.Intn(9)), int64(1+rng.Intn(9)))
		}
		ratio := func(u, v int) *big.Rat { return new(big.Rat).Quo(assign[u], assign[v]) }

		g := ratiograph.New()
		var ops []ratiograph.Op
		perm := rng.Perm(n)
		for i := 1; i < n; i++ { // 随机生成树
			u, v := perm[i], perm[rng.Intn(i)]
			ops = append(ops, ratiograph.AddOp(ratiograph.Edge{U: names[u], V: names[v], Ratio: ratio(u, v)}))
		}
		for k := 0; k < n; k++ { // 额外一致边
			u, v := rng.Intn(n), rng.Intn(n)
			if u != v && !hasEdgeOps(ops, names[u], names[v]) {
				ops = append(ops, ratiograph.AddOp(ratiograph.Edge{U: names[u], V: names[v], Ratio: ratio(u, v)}))
			}
		}
		sol, cert, err := g.Apply(ops...)
		if err != nil || cert != nil {
			t.Fatalf("trial %d: consistent graph rejected: cert=%v err=%v", trial, cert, err)
		}
		if len(sol.Components) != 1 {
			t.Fatalf("trial %d: got %d components, want 1", trial, len(sol.Components))
		}
		if !sol.Satisfies(g) {
			t.Fatalf("trial %d: solution violates edges", trial)
		}
		// 解与真实赋值成比例：val_i / val_0 == assign_i / assign_0
		base, _ := sol.Value(names[0])
		for i := 1; i < n; i++ {
			vi, _ := sol.Value(names[i])
			lhs := new(big.Rat).Quo(new(big.Rat).SetInt(vi), new(big.Rat).SetInt(base))
			if lhs.Cmp(new(big.Rat).Quo(assign[i], assign[0])) != 0 {
				t.Fatalf("trial %d: solution not proportional to assignment at %s", trial, names[i])
			}
		}
		// 注入冲突边（找一对尚无边的节点）
		edgesBefore := g.EdgeCount()
		u, v := -1, -1
		for i := 0; i < n && u < 0; i++ {
			for j := i + 1; j < n; j++ {
				if !g.HasEdge(names[i], names[j]) {
					u, v = i, j
					break
				}
			}
		}
		if u < 0 {
			continue // 完全图，跳过注入
		}
		bad := ratiograph.Edge{U: names[u], V: names[v], Ratio: new(big.Rat).Mul(ratio(u, v), big.NewRat(2, 1))}
		_, cert, err = g.Apply(ratiograph.AddOp(bad))
		if err != nil || cert == nil || !cert.Verify() {
			t.Fatalf("trial %d: expected valid certificate, cert=%v err=%v", trial, cert, err)
		}
		if g.EdgeCount() != edgesBefore {
			t.Fatalf("trial %d: graph mutated after conflict", trial)
		}
	}
}

func hasEdgeOps(ops []ratiograph.Op, u, v string) bool {
	for _, op := range ops {
		e := op.Edge
		if (e.U == u && e.V == v) || (e.U == v && e.V == u) {
			return true
		}
	}
	return false
}
