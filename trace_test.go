package dataeng_test

import (
	"math/big"
	"reflect"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

func TestMinFillSelection(t *testing.T) {
	// 星形图：中心 z 连 a、b；z 的填充边数为 0（邻居 a,b 已在同一 scope 成团）。
	// 这里用两个因子构造路径 a-z-b，z 有一条填充边，端点 a、b 填充为 0，
	// 因此首轮必须在 a/b 中选择。
	vars := []dataeng.Variable{
		{ID: "z", Domain: []string{"z0", "z1", "z2"}},
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1", "b2", "b3"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "z"}, Entries: []dataeng.Entry{{[]string{"a0", "z0"}, rat(1, 1)}}},
		{Scope: []string{"z", "b"}, Entries: []dataeng.Entry{{[]string{"z0", "b0"}, rat(1, 1)}}},
	}
	model, _ := dataeng.NewModel(vars, factors)
	res, err := model.Query([]string{"z"}, nil, big.NewInt(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Trace) != 2 {
		t.Fatalf("want 2 rounds, got %d", len(res.Trace))
	}
	// a 与 b 填充边数都为 0，a 的邻居域积=3 小于 b 的邻居域积=3？
	// 二者邻居都只有 z（域大小 3），域积相等，按 ASCII 序选 a。
	if res.Trace[0].Eliminated != "a" {
		t.Fatalf("first elimination=%s want a (ASCII tiebreak)", res.Trace[0].Eliminated)
	}
	// 消 a 不产生填充边；随后消 b 时其邻居 z 已与 b 相邻，同样无填充。
	if len(res.Trace[0].FillEdges) != 0 {
		t.Fatalf("unexpected fill edges round 1: %v", res.Trace[0].FillEdges)
	}

	// 因子团 {x,m} 与 {x,y} 共享 x，但 m、y 无边。
	// 令 x 是唯一隐藏变量（m、y 都保留），首轮且唯一一轮就必须在
	// 其邻居 m、y 之间新增 1 条填充边。
	vars2 := []dataeng.Variable{
		{ID: "x", Domain: []string{"x0", "x1"}},
		{ID: "y", Domain: []string{"y0", "y1"}},
		{ID: "m", Domain: []string{"m0", "m1"}},
	}
	factors2 := []dataeng.Factor{
		{Scope: []string{"x", "m"}, Entries: []dataeng.Entry{{[]string{"x0", "m0"}, rat(1, 1)}}},
		{Scope: []string{"x", "y"}, Entries: []dataeng.Entry{{[]string{"x0", "y0"}, rat(1, 1)}}},
	}
	model2, _ := dataeng.NewModel(vars2, factors2)
	res2, _ := model2.Query([]string{"m", "y"}, nil, big.NewInt(1<<20))
	if len(res2.Trace) != 1 || res2.Trace[0].Eliminated != "x" {
		t.Fatalf("want single elimination of x, trace=%+v", res2.Trace)
	}
	fillCount := 0
	for _, r := range res2.Trace {
		for _, e := range r.FillEdges {
			fillCount++
			if e[0] >= e[1] {
				t.Fatalf("fill edge endpoints not ASCII ordered: %v", e)
			}
		}
	}
	if fillCount != 1 {
		t.Fatalf("expected 1 fill edge, got %d, trace=%+v", fillCount, res2.Trace)
	}
	if res2.Trace[0].FillEdges[0] != [2]string{"m", "y"} {
		t.Fatalf("fill edge = %v want [m y]", res2.Trace[0].FillEdges)
	}
}

func TestTraceScopeAndCells(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1", "a2"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"b"}, Entries: []dataeng.Entry{{[]string{"b0"}, rat(1, 1)}}},
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{{[]string{"a0", "b0"}, rat(2, 1)}}},
	}
	model, _ := dataeng.NewModel(vars, factors)
	// 保留 b、c，隐藏变量 a 同时出现在两个因子中。
	res, _ := model.Query([]string{"b", "c"}, nil, big.NewInt(1<<20))
	if len(res.Trace) != 1 || res.Trace[0].Eliminated != "a" {
		t.Fatalf("trace = %+v", res.Trace)
	}
	r := res.Trace[0]
	if !reflect.DeepEqual(r.CombinedScope, []string{"a", "b"}) {
		t.Fatalf("combined scope = %v", r.CombinedScope)
	}
	if len(r.ResultScope) != 1 || r.ResultScope[0] != "b" {
		t.Fatalf("result scope = %v", r.ResultScope)
	}
	if r.RequiredCells.Cmp(big.NewInt(6)) != 0 {
		t.Fatalf("required cells = %s want 6", r.RequiredCells)
	}
	if len(r.InvolvedScopes) != 1 {
		t.Fatalf("involved scopes = %v", r.InvolvedScopes)
	}
}

func TestEvidenceExcludedFromGraph(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{{[]string{"a0", "b0"}, rat(1, 1)}}},
		{Scope: []string{"b", "c"}, Entries: []dataeng.Entry{{[]string{"b0", "c0"}, rat(1, 1)}}},
	}
	model, _ := dataeng.NewModel(vars, factors)
	// 固定 b 后，a、c 成为不相连的孤立节点，消元不应出现 a-c 填充边。
	res, err := model.Query([]string{"a"}, map[string]string{"b": "b0", "c": "c0"}, big.NewInt(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range res.Trace {
		for _, e := range r.FillEdges {
			t.Fatalf("evidence-fixed variable must break the graph, got edge %v", e)
		}
	}
}
