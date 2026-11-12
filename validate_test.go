package dataeng_test

import (
	"math/big"
	"strings"
	"testing"

	dataeng "example.org/dataeng/q0307"
)

func TestRejections(t *testing.T) {
	base := []dataeng.Variable{{ID: "a", Domain: []string{"a0", "a1"}}}

	cases := []struct {
		name    string
		vars    []dataeng.Variable
		factors []dataeng.Factor
	}{
		{"empty vars", nil, nil},
		{"41 vars", chainVars(41), nil},
		{"non-ascii id", []dataeng.Variable{{ID: "变量", Domain: []string{"x"}}}, nil},
		{"empty id", []dataeng.Variable{{ID: "", Domain: []string{"x"}}}, nil},
		{"dup id", []dataeng.Variable{
			{ID: "a", Domain: []string{"x"}}, {ID: "a", Domain: []string{"y"}},
		}, nil},
		{"empty domain", []dataeng.Variable{{ID: "a", Domain: nil}}, nil},
		{"domain too large", []dataeng.Variable{{ID: "a", Domain: domN(17)}}, nil},
		{"dup domain value", []dataeng.Variable{{ID: "a", Domain: []string{"x", "x"}}}, nil},
		{"unknown factor var", base, []dataeng.Factor{
			{Scope: []string{"ghost"}, Entries: []dataeng.Entry{{[]string{"x"}, rat(1, 1)}}},
		}},
		{"repeated scope var", base, []dataeng.Factor{
			{Scope: []string{"a", "a"}, Entries: []dataeng.Entry{{[]string{"a0", "a0"}, rat(1, 1)}}},
		}},
		{"dup assignment", base, []dataeng.Factor{
			{Scope: []string{"a"}, Entries: []dataeng.Entry{
				{[]string{"a0"}, rat(1, 1)}, {[]string{"a0"}, rat(2, 1)},
			}},
		}},
		{"out of domain value", base, []dataeng.Factor{
			{Scope: []string{"a"}, Entries: []dataeng.Entry{{[]string{"zz"}, rat(1, 1)}}},
		}},
		{"negative value", base, []dataeng.Factor{
			{Scope: []string{"a"}, Entries: []dataeng.Entry{{[]string{"a0"}, rat(-1, 1)}}},
		}},
		{"arity mismatch", base, []dataeng.Factor{
			{Scope: []string{"a"}, Entries: []dataeng.Entry{{[]string{"a0", "a1"}, rat(1, 1)}}},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := dataeng.NewModel(tc.vars, tc.factors); err == nil {
				t.Fatalf("%s: expected rejection", tc.name)
			}
		})
	}
}

func TestQueryRejections(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
	}
	model, err := dataeng.NewModel(vars, []dataeng.Factor{
		{Scope: []string{"a"}, Entries: []dataeng.Entry{{[]string{"a0"}, rat(1, 1)}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := model.Query([]string{"a"}, nil, nil); err == nil {
		t.Fatal("nil budget must be rejected")
	}
	if _, err := model.Query([]string{"a"}, nil, big.NewInt(0)); err == nil {
		t.Fatal("zero budget must be rejected")
	}
	if _, err := model.Query([]string{"a"}, nil, big.NewInt(-1)); err == nil {
		t.Fatal("negative budget must be rejected")
	}
	if _, err := model.Query([]string{"ghost"}, nil, big.NewInt(1)); err == nil {
		t.Fatal("unknown query variable must be rejected")
	}
	if _, err := model.Query([]string{"a", "a"}, nil, big.NewInt(1)); err == nil {
		t.Fatal("repeated query variable must be rejected")
	}
	if _, err := model.Query([]string{"a"}, map[string]string{"a": "a0"}, big.NewInt(1)); err == nil {
		t.Fatal("Q/E overlap must be rejected")
	}
	if _, err := model.Query(nil, map[string]string{"b": "zz"}, big.NewInt(1)); err == nil {
		t.Fatal("out-of-domain evidence must be rejected")
	}
	if _, err := model.Query(nil, map[string]string{"ghost": "x"}, big.NewInt(1)); err == nil {
		t.Fatal("unknown evidence variable must be rejected")
	}
}

func TestExactRationalsAndImmutability(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
	}
	// 1/3 这类分母无法用 float64 精确表示，全程 big.Rat 应保持精确。
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 3)},
			{[]string{"a1", "b1"}, rat(2, 7)},
		}},
	}
	model, err := dataeng.NewModel(vars, factors)
	if err != nil {
		t.Fatal(err)
	}
	res, err := model.Query([]string{"a", "b"}, nil, big.NewInt(16))
	if err != nil {
		t.Fatal(err)
	}
	wantZ := new(big.Rat).Add(rat(1, 3), rat(2, 7)) // 13/21
	if res.Z.Cmp(wantZ) != 0 || res.Z.RatString() != "13/21" {
		t.Fatalf("Z=%s want 13/21", res.Z.RatString())
	}
	var p *big.Rat
	for _, e := range res.Probability {
		if e.Assignment[0] == "a0" {
			p = e.Value
		}
	}
	// (1/3)/(13/21) = 7/13
	if p == nil || p.RatString() != "7/13" {
		t.Fatalf("P(a0b0)=%v want 7/13", p)
	}

	// 不可变性：篡改返回值与输入后重新查询，结果不变。
	res.Z.SetInt64(999)
	res.U[0].Value.SetInt64(888)
	vars[0].Domain[0] = "mutated"
	factors[0].Entries[0].Value.SetInt64(777)
	model2, _ := dataeng.NewModel([]dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
	}, []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 3)},
			{[]string{"a1", "b1"}, rat(2, 7)},
		}},
	})
	res2, _ := model2.Query([]string{"a", "b"}, nil, big.NewInt(16))
	if res2.Z.RatString() != "13/21" {
		t.Fatalf("model/result not isolated: Z=%s", res2.Z.RatString())
	}
}

func TestReQueryWithDifferentEvidence(t *testing.T) {
	vars := []dataeng.Variable{
		{ID: "a", Domain: []string{"a0", "a1"}},
		{ID: "b", Domain: []string{"b0", "b1"}},
	}
	factors := []dataeng.Factor{
		{Scope: []string{"a", "b"}, Entries: []dataeng.Entry{
			{[]string{"a0", "b0"}, rat(1, 1)},
			{[]string{"a0", "b1"}, rat(2, 1)},
			{[]string{"a1", "b0"}, rat(4, 1)},
			{[]string{"a1", "b1"}, rat(8, 1)},
		}},
	}
	model, _ := dataeng.NewModel(vars, factors)

	first, _ := model.Query([]string{"b"}, map[string]string{"a": "a0"}, big.NewInt(8))
	second, _ := model.Query([]string{"b"}, map[string]string{"a": "a1"}, big.NewInt(8))

	// 第一次查询的轨迹不得被第二次查询影响。
	if len(first.Trace) != 0 || first.Status != dataeng.StatusOK {
		t.Fatalf("first query altered: %+v", first)
	}
	// a=a1 行的势为 4 和 8，Z=12。
	if second.Z.Cmp(rat(12, 1)) != 0 {
		t.Fatalf("second query Z=%s want 12 (must re-restrict original factors)", second.Z.RatString())
	}
	// 第一次结果仍保持 a=a0 的 Z=3。
	if first.Z.Cmp(rat(3, 1)) != 0 {
		t.Fatalf("first Z mutated to %s", first.Z.RatString())
	}
}

func chainVars(n int) []dataeng.Variable {
	out := make([]dataeng.Variable, n)
	for i := range out {
		out[i] = dataeng.Variable{ID: "v" + strings.Repeat("x", 1) + string(rune('a'+i%26)), Domain: []string{"0", "1"}}
	}
	return out
}

func domN(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = "d" + string(rune('a'+i%26)) + string(rune('a'+(i/26)%26))
	}
	return out
}
