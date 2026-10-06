package colcalc

import (
	"strings"
	"testing"
)

func row(kv ...any) Row {
	r := Row{}
	for i := 0; i < len(kv); i += 2 {
		r[kv[i].(string)] = kv[i+1]
	}
	return r
}

func TestThreeStatesAreIndependent(t *testing.T) {
	r := row("n", nil, "x", 1.0)
	cases := []struct {
		name string
		expr Expr
		want Value
	}{
		{"missing col", Col{"nope"}, Missingv()},
		{"null col", Col{"n"}, Nullv()},
		{"div by zero", Arith{Div, Lit{Numv(1)}, Lit{Numv(0)}}, Errv("division by zero")},
		{"missing != null", Arith{Add, Col{"nope"}, Col{"n"}}, Missingv()},                                        // missing wins over null
		{"null != error", Arith{Add, Col{"n"}, Arith{Div, Lit{Numv(1)}, Lit{Numv(0)}}}, Errv("division by zero")}, // error wins over null
		{"null propagates", Arith{Add, Col{"n"}, Lit{Numv(2)}}, Nullv()},
		{"missing propagates", Cmp{Eq, Col{"nope"}, Lit{Numv(1)}}, Missingv()},
		{"is_missing", Pred{IsMissing, Col{"nope"}}, Boolv(true)},
		{"is_null", Pred{IsNull, Col{"n"}}, Boolv(true)},
		{"is_error", Pred{IsError, Arith{Div, Lit{Numv(1)}, Lit{Numv(0)}}}, Boolv(true)},
		{"is_missing false on number", Pred{IsMissing, Col{"x"}}, Boolv(false)},
		{"is_null false on missing", Pred{IsNull, Col{"nope"}}, Boolv(false)},
		{"is_error false on null", Pred{IsError, Col{"n"}}, Boolv(false)},
	}
	for _, c := range cases {
		if got := Eval(c.expr, r); !Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestArithmeticAndComparison(t *testing.T) {
	r := row("a", 6.0, "b", 3.0, "s", "hi")
	cases := []struct {
		expr Expr
		want Value
	}{
		{Arith{Add, Col{"a"}, Col{"b"}}, Numv(9)},
		{Arith{Sub, Col{"a"}, Col{"b"}}, Numv(3)},
		{Arith{Mul, Col{"a"}, Col{"b"}}, Numv(18)},
		{Arith{Div, Col{"a"}, Col{"b"}}, Numv(2)},
		{Arith{Add, Col{"a"}, Col{"s"}}, Errv("arithmetic on number and string")},
		{Cmp{Gt, Col{"a"}, Col{"b"}}, Boolv(true)},
		{Cmp{Le, Col{"a"}, Col{"b"}}, Boolv(false)},
		{Cmp{Eq, Col{"s"}, Lit{Strv("hi")}}, Boolv(true)},
		{Cmp{Lt, Lit{Strv("a")}, Lit{Strv("b")}}, Boolv(true)},
		{Cmp{Eq, Col{"a"}, Col{"s"}}, Errv("cannot compare number with string")},
		{Cmp{Lt, Lit{Boolv(true)}, Lit{Boolv(false)}}, Errv("booleans only support == and !=")},
		{Logic{And, Lit{Boolv(true)}, Lit{Boolv(false)}}, Boolv(false)},
		{Logic{Or, Lit{Boolv(true)}, Lit{Boolv(false)}}, Boolv(true)},
		{Not{Lit{Boolv(true)}}, Boolv(false)},
		{Not{Col{"nope"}}, Missingv()},
	}
	for _, c := range cases {
		if got := Eval(c.expr, r); !Equal(got, c.want) {
			t.Errorf("got %v, want %v", got, c.want)
		}
	}
}

func TestIfEvaluatesOnlySelectedBranch(t *testing.T) {
	r := row("x", 1.0)
	poison := Arith{Div, Lit{Numv(1)}, Lit{Numv(0)}} // error if evaluated
	cases := []struct {
		name string
		expr Expr
		want Value
	}{
		{"then selected, else poisoned", If{Lit{Boolv(true)}, Lit{Numv(42)}, poison}, Numv(42)},
		{"else selected, then poisoned", If{Lit{Boolv(false)}, poison, Lit{Strv("ok")}}, Strv("ok")},
		{"else selected, then missing col", If{Lit{Boolv(false)}, Col{"nope"}, Lit{Numv(7)}}, Numv(7)},
		{"cond null propagates", If{Lit{Nullv()}, poison, poison}, Nullv()},
		{"cond missing propagates", If{Col{"nope"}, poison, poison}, Missingv()},
		{"cond error propagates", If{poison, Lit{Numv(1)}, Lit{Numv(2)}}, Errv("division by zero")},
		{"cond non-bool is error", If{Lit{Numv(1)}, Lit{Numv(1)}, Lit{Numv(2)}}, Errv("if condition must be bool, got number")},
		{"nested lazy", If{Cmp{Gt, Col{"x"}, Lit{Numv(0)}}, If{Lit{Boolv(false)}, poison, Lit{Numv(5)}}, poison}, Numv(5)},
	}
	for _, c := range cases {
		if got := Eval(c.expr, r); !Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestTypesInferredPerRowNotFirstRow(t *testing.T) {
	tab, err := ParseTable([]byte(`[
		{"v": 1},
		{"v": "two"},
		{"v": null},
		{"w": true},
		{"v": 1/0}
	]`))
	if err == nil {
		t.Fatal("expected parse error for invalid JSON")
	}
	tab, err = ParseTable([]byte(`[
		{"v": 1},
		{"v": "two"},
		{"v": null},
		{"w": true},
		{"v": [1,2]}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	got := tab.InferKinds(Col{"v"})
	want := []Kind{Number, String, Null, Missing, Error}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("row %d: got kind %v, want %v (all: %v)", i, got[i], want[i], got)
		}
	}
	// A first-row-based inference would claim Number for every row.
	if got[0] != Number {
		t.Fatalf("row 0 should be Number, got %v", got[0])
	}
}

func TestComputeColumnEndToEnd(t *testing.T) {
	tab, err := ParseTable([]byte(`[
		{"price": 10, "qty": 2},
		{"price": 5},
		{"price": null, "qty": 3},
		{"price": "oops", "qty": 1}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	total := Arith{Mul, Col{"price"}, Col{"qty"}}
	vals := tab.Compute(total)
	if !Equal(vals[0], Numv(20)) {
		t.Errorf("row0: got %v", vals[0])
	}
	if vals[1].Kind != Missing {
		t.Errorf("row1: got %v, want missing", vals[1])
	}
	if vals[2].Kind != Null {
		t.Errorf("row2: got %v, want null", vals[2])
	}
	if vals[3].Kind != Error {
		t.Errorf("row3: got %v, want error", vals[3])
	}

	rows := tab.ComputeColumn("total", total)
	if rows[0]["total"] != 20.0 {
		t.Errorf("row0 total: %v", rows[0]["total"])
	}
	if _, ok := rows[1]["total"]; ok {
		t.Errorf("row1 total should be absent (missing)")
	}
	if v, ok := rows[2]["total"]; !ok || v != nil {
		t.Errorf("row2 total should be JSON null, got %v", v)
	}
	errObj, ok := rows[3]["total"].(map[string]string)
	if !ok || !strings.Contains(errObj["$error"], "arithmetic") {
		t.Errorf("row3 total should be tagged error, got %v", rows[3]["total"])
	}
}

func TestConditionalColumnOverTable(t *testing.T) {
	tab, err := ParseTable([]byte(`[
		{"x": 5},
		{"x": -1},
		{"x": null},
		{}
	]`))
	if err != nil {
		t.Fatal(err)
	}
	// abs(x) guarded: only compute 0-x when x<0; division poison in the
	// unselected branch must never leak.
	expr := If{
		Cond: Pred{IsNull, Col{"x"}},
		Then: Lit{Strv("was null")},
		Else: If{
			Cond: Cmp{Lt, Col{"x"}, Lit{Numv(0)}},
			Then: Arith{Sub, Lit{Numv(0)}, Col{"x"}},
			Else: Col{"x"},
		},
	}
	vals := tab.Compute(expr)
	want := []Value{Numv(5), Numv(1), Strv("was null"), Missingv()}
	for i := range want {
		if !Equal(vals[i], want[i]) {
			t.Errorf("row %d: got %v, want %v", i, vals[i], want[i])
		}
	}
}
