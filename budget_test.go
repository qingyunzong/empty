package dataeng_test

import (
	"math/big"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

func TestBudgetExactAndOffByOne(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1", "a2"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 1)},
			{[]string{"a0", "b1"}, rat(2, 1)},
			{[]string{"a1", "b0"}, rat(3, 1)},
			{[]string{"a1", "b1"}, rat(4, 1)},
		}},
	}
	model, err := dataeng.NewModel(vars, factors)
	if err != nil {
		t.Fatal(err)
	}

	// 首轮消去 a，结合 scope={a,b}，精确稠密需求 3*2=6。
	// 预算差 1：返回 needsBudget，且不给出任何概率。
	short, err := model.Query([]string{"b", "c"}, nil, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	if short.Status != dataeng.StatusNeedsBudget {
		t.Fatalf("status=%s want needsBudget", short.Status)
	}
	if short.NeedsVariable != "a" || short.RequiredCells.Cmp(big.NewInt(6)) != 0 {
		t.Fatalf("needs a/6, got %s/%s", short.NeedsVariable, short.RequiredCells)
	}
	if short.Probability != nil || short.U != nil || short.Z != nil {
		t.Fatalf("budget failure must not return probabilities: %+v", short)
	}
	if len(short.Trace) != 0 {
		t.Fatalf("no round should execute before the failed combine, got %d", len(short.Trace))
	}

	// 预算恰足 6：首轮通过；随后孤立隐藏 c 以合成一元因子（2 单元）消去。
	exact, err := model.Query([]string{"b", "c"}, nil, big.NewInt(6))
	if err != nil {
		t.Fatal(err)
	}
	if exact.Status != dataeng.StatusOK {
		t.Fatalf("status=%s want ok, required=%s", exact.Status, exact.RequiredCells)
	}
	assertAgainstEnumerator(t, "exact-budget", vars, factors, []string{"b", "c"}, nil, 6)
}

func TestBudgetZeroFactorNotSkipped(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
	}
	// 消 a 时结合 scope={a,b}（4 单元）。独立的 c 因子被证据清空为零因子，
	// 但 a 的结合表预算检查必须照常按稠密上界 4 执行，不得因存在零因子而跳过。
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 1)}, {[]string{"a1", "b1"}, rat(1, 1)},
		}},
		{Scope: []string{"c"}, Entries: []dataeng.Entry{{[]string{"c0"}, rat(1, 1)}}},
	}
	model, _ := dataeng.NewModel(vars, factors)
	res, err := model.Query(nil, map[string]string{"c": "c1"}, big.NewInt(3))
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != dataeng.StatusNeedsBudget {
		t.Fatalf("zero factors must still hit budget check, got %s", res.Status)
	}
	if res.NeedsVariable != "a" || res.RequiredCells.Cmp(big.NewInt(4)) != 0 {
		t.Fatalf("want a/4, got %s/%s", res.NeedsVariable, res.RequiredCells)
	}

	// 预算给足后，零表相乘结果为空，最终 Z=0，明确报矛盾而非伪造均匀分布。
	res2, _ := model.Query(nil, map[string]string{"c": "c1"}, big.NewInt(4))
	if res2.Status != dataeng.StatusContradiction || res2.Z.Sign() != 0 {
		t.Fatalf("want contradiction with sufficient budget, got %+v", res2)
	}
}

func TestBudgetFinalStage(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
	}
	model, _ := dataeng.NewModel(vars, nil) // 无因子，全部变量孤立

	// 每轮一元结合只需 2 单元，但最终 Q={a,b,c} 的稠密上界是 8。
	res, err := model.Query([]string{"a", "b", "c"}, nil, big.NewInt(7))
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != dataeng.StatusNeedsBudget ||
		res.NeedsVariable != "final" || res.RequiredCells.Cmp(big.NewInt(8)) != 0 {
		t.Fatalf("want final/8, got %s/%s/%s", res.Status, res.NeedsVariable, res.RequiredCells)
	}
	if len(res.Trace) != 0 {
		t.Fatalf("no hidden variables, expected empty prefix, got %d", len(res.Trace))
	}

	ok, err := model.Query([]string{"a", "b", "c"}, nil, big.NewInt(8))
	if err != nil {
		t.Fatal(err)
	}
	if ok.Status != dataeng.StatusOK {
		t.Fatalf("budget 8 must succeed, got %s", ok.Status)
	}
}

func TestBudgetPrefixRecorded(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
		{ID: "d", Domain: []string{"d0", "d1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{{[]string{"a0", "b0"}, rat(1, 1)}}},
		{Scope: []string{"b", "c"}, Entries: []dataeng.Entry{{[]string{"b0", "c0"}, rat(1, 1)}}},
		{Scope: []string{"c", "d"}, Entries: []dataeng.Entry{{[]string{"c0", "d0"}, rat(1, 1)}}},
	}
	model, _ := dataeng.NewModel(vars, factors)
	// 预算 2：首轮结合 {a,b} 需 4 单元即失败、前缀为空。
	res0, err := model.Query([]string{"d"}, nil, big.NewInt(2))
	if err != nil {
		t.Fatal(err)
	}
	if res0.Status != dataeng.StatusNeedsBudget || len(res0.Trace) != 0 {
		t.Fatalf("budget 2 should fail before first round: %+v", res0)
	}

	// 预算 3：链上每轮都需 4 单元，但先用孤立变量 s（域 2，合成一元因子
	// 仅需 2 单元）成功执行一轮，随后在链的首轮失败，得到非空已执行前缀。
	varsWithSolo := append(append([]dataeng.Variable{}, vars...),
		dataeng.Variable{ID: "s", Domain: []string{"s0", "s1"}})
	modelSolo, _ := dataeng.NewModel(varsWithSolo, factors)
	res, err := modelSolo.Query([]string{"d"}, nil, big.NewInt(3))
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != dataeng.StatusNeedsBudget {
		t.Fatalf("status=%s", res.Status)
	}
	if len(res.Trace) == 0 {
		t.Fatal("expected a non-empty executed prefix")
	}
	// 前缀中的每一轮都必须完整记录来自实际执行的字段。
	for i, r := range res.Trace {
		if r.Eliminated == "" || r.RequiredCells == nil ||
			len(r.CombinedScope) == 0 || len(r.InvolvedScopes) == 0 {
			t.Fatalf("prefix round %d incomplete: %+v", i, r)
		}
	}
}
