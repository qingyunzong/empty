package dataeng_test

import (
	"math/big"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

func TestReversedAxisAndSharedPair(t *testing.T) {
	// 两个因子共享两个变量，且 scope 轴序相反 (a,b) 与 (b,a)。
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 1)},
			{[]string{"a0", "b1"}, rat(2, 1)},
			{[]string{"a1", "b0"}, rat(3, 1)},
		}},
		{Scope: []string{"b", "a"}, Entries: []dataeng.Entry{
			{[]string{"b0", "a0"}, rat(2, 1)},
			{[]string{"b1", "a0"}, rat(1, 2)},
			{[]string{"b0", "a1"}, rat(1, 3)},
		}},
	}
	assertAgainstEnumerator(t, "reversed-axis", vars, factors, []string{"b"}, nil, 1<<20)

	res := assertAgainstEnumerator(t, "shared-pair-evidence", vars, factors,
		[]string{"b"}, map[string]string{"a": "a1"}, 1<<20)
	if len(res.Trace) != 0 {
		t.Fatalf("no hidden variable expected, got %d rounds", len(res.Trace))
	}
}

func TestScalarZero(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"x", "y"}},
		{ID: "b", Domain: []string{"p", "q"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a"}, Entries: []dataeng.Entry{
			{[]string{"x"}, rat(2, 1)}, {[]string{"y"}, rat(3, 1)},
		}},
		{Scope: nil, Entries: []dataeng.Entry{{nil, rat(0, 1)}}},
	}
	model, _ := dataeng.NewModel(vars, factors)
	res, err := model.Query([]string{"b"}, nil, big.NewInt(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != dataeng.StatusContradiction {
		t.Fatalf("status=%s want contradiction", res.Status)
	}
	if res.Probability != nil || len(res.U) != 0 || res.Z == nil || res.Z.Sign() != 0 {
		t.Fatalf("contradiction must yield zero U, zero Z and no probability: %+v", res)
	}
}

func TestEmptyFactorSetAndIsolatedHidden(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1", "b2"}},
		{ID: "c", Domain: []string{"c0", "c1", "c2", "c4"}},
	}
	// 空因子集：乘积恒为 1；隐藏孤立变量 b、c 必须贡献域大小 3 和 4。
	model, err := dataeng.NewModel(vars, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := model.Query([]string{"a"}, nil, big.NewInt(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != dataeng.StatusOK {
		t.Fatalf("status=%s", res.Status)
	}
	if res.Z.Cmp(rat(24, 1)) != 0 {
		t.Fatalf("Z=%s want 24 (=2*3*4)", res.Z.RatString())
	}
	for _, e := range res.U {
		if e.Value.Cmp(rat(12, 1)) != 0 {
			t.Fatalf("U=%s want 12", e.Value.RatString())
		}
	}
	for _, p := range res.Probability {
		if p.Value.Cmp(rat(1, 2)) != 0 {
			t.Fatalf("P=%s want 1/2", p.Value.RatString())
		}
	}

	// 额外加入完全孤立的变量 d，核对合成一元因子的轨迹。
	vars2 := append(append([]dataeng.Variable{}, vars...),
		dataeng.Variable{ID: "d", Domain: []string{"d0", "d1"}})
	factors := []dataeng.Factor{
		{Scope: []string{"a"}, Entries: []dataeng.Entry{
			{[]string{"a0"}, rat(1, 1)}, {[]string{"a1"}, rat(3, 1)},
		}},
	}
	res2 := assertAgainstEnumerator(t, "isolated-d", vars2, factors, []string{"a"}, nil, 1<<20)
	found := false
	for _, r := range res2.Trace {
		if r.Eliminated == "d" && r.Synthetic &&
			len(r.InvolvedScopes) == 1 && len(r.InvolvedScopes[0]) == 1 &&
			r.RequiredCells.Cmp(big.NewInt(2)) == 0 &&
			len(r.ResultScope) == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("synthetic unary elimination for isolated d missing: %+v", res2.Trace)
	}
}

func TestEmptyQueryAndEvidenceContradiction(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 1)},
			{[]string{"a1", "b1"}, rat(5, 1)},
		}},
	}
	// Q 空：U 退化为单个标量条目。
	assertAgainstEnumerator(t, "empty-q", vars, factors, nil, nil, 1<<20)
	model, _ := dataeng.NewModel(vars, factors)
	res, _ := model.Query(nil, nil, big.NewInt(1<<20))
	if res.Z.Cmp(rat(6, 1)) != 0 || len(res.U) != 1 || len(res.U[0].Assignment) != 0 {
		t.Fatalf("empty Q scalar result wrong: %+v Z=%s", res.U, res.Z)
	}

	// 证据固定到零组合 -> 矛盾，而非均匀分布。
	res2, _ := model.Query(nil,
		map[string]string{"a": "a0", "b": "b1"}, big.NewInt(1<<20))
	if res2.Status != dataeng.StatusContradiction ||
		res2.Probability != nil || res2.Z.Sign() != 0 || len(res2.U) != 0 {
		t.Fatalf("evidence contradiction mishandled: %+v", res2)
	}
}

func TestDisconnectedComponents(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
		{ID: "d", Domain: []string{"d0", "d1"}},
	}
	factors := []dataeng.Factor{
		// 分量一：a-b
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 1)},
			{[]string{"a1", "b1"}, rat(2, 1)},
		}},
		// 分量二：c-d
		{Scope: []string{"c", "d"}, Entries: []dataeng.Entry{
			{[]string{"c0", "d0"}, rat(3, 1)},
			{[]string{"c1", "d1"}, rat(0, 1)},
		}},
	}
	assertAgainstEnumerator(t, "disconnected", vars, factors,
		[]string{"a", "c"}, nil, 1<<20)

	// 图应保持断开：轨迹中不应出现跨分量的填充边。
	model, _ := dataeng.NewModel(vars, factors)
	res, _ := model.Query([]string{"a", "c"}, nil, big.NewInt(1<<20))
	setA := map[string]bool{"a": true, "b": true}
	setC := map[string]bool{"c": true, "d": true}
	for _, r := range res.Trace {
		for _, e := range r.FillEdges {
			if (setA[e[0]] && setC[e[1]]) || (setC[e[0]] && setA[e[1]]) {
				t.Fatalf("cross-component fill edge appeared: %v", e)
			}
		}
	}
}
