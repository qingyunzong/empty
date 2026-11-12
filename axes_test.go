package dataeng_test

import (
	"math/big"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

func TestQueryAxisCompletionAndOrder(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1", "b2"}},
		{ID: "c", Domain: []string{"c0", "c1"}},
	}
	// 因子只涉及 a；b 从未出现在任何因子中，但作为 Q 轴必须被补齐。
	factors := []dataeng.Factor{
		{Scope: []string{"a"}, Entries: []dataeng.Entry{
			{[]string{"a0"}, rat(1, 1)}, {[]string{"a1"}, rat(3, 1)},
		}},
	}
	assertAgainstEnumerator(t, "axis-complete", vars, factors,
		[]string{"b", "a"}, nil, 1<<20)

	model, _ := dataeng.NewModel(vars, factors)
	res, err := model.Query([]string{"b", "a"}, nil, big.NewInt(1<<20))
	if err != nil {
		t.Fatal(err)
	}
	// 3*2=6 个非零元组，按 (b,a) 轴的字典序排列，b 在外层。
	if len(res.U) != 6 {
		t.Fatalf("want 6 materialized tuples, got %d", len(res.U))
	}
	wantOrder := []struct{ b, a string }{
		{"b0", "a0"}, {"b0", "a1"}, {"b1", "a0"}, {"b1", "a1"},
		{"b2", "a0"}, {"b2", "a1"},
	}
	for i, w := range wantOrder {
		if res.U[i].Assignment[0] != w.b || res.U[i].Assignment[1] != w.a {
			t.Fatalf("tuple %d = %v want [%s %s]", i, res.U[i].Assignment, w.b, w.a)
		}
	}
	// Z = (1+3)*2(隐藏 c 域)*3(b 轴) = 24。
	if res.Z.Cmp(rat(24, 1)) != 0 {
		t.Fatalf("Z=%s want 24", res.Z.RatString())
	}
}

func TestDomainSize16AndSparseZeros(t *testing.T) {
	domain := make([]string, 16)
	for i := range domain {
		domain[i] = string(rune('a' + i))
	}
	vars := []dataeng.Variable{
		{ID: "x", Domain: domain},
		{ID: "y", Domain: []string{"y0", "y1"}},
	}
	entries := []dataeng.Entry{
		{[]string{"a", "y0"}, rat(1, 7)},
		{[]string{"p", "y1"}, rat(2, 13)},
		// 显式零与缺省都必须视为 0，且不能制造重复赋值。
		{[]string{"a", "y1"}, rat(0, 1)},
	}
	factors := []dataeng.Factor{{Scope: []string{"x", "y"}, Entries: entries}}
	assertAgainstEnumerator(t, "domain16-sparse", vars, factors,
		[]string{"x", "y"}, nil, 64)

	model, _ := dataeng.NewModel(vars, factors)
	res, _ := model.Query([]string{"x", "y"}, nil, big.NewInt(64))
	if len(res.U) != 2 {
		t.Fatalf("only two non-zero tuples expected, got %d", len(res.U))
	}
	wantZ := new(big.Rat).Add(rat(1, 7), rat(2, 13)) // 27/91
	if res.Z.Cmp(wantZ) != 0 {
		t.Fatalf("Z=%s want %s", res.Z.RatString(), wantZ.RatString())
	}
}
