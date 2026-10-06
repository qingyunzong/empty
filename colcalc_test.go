package colcalc

import (
	"strings"
	"testing"
)

// mixedRows exercises every per-row combination: numbers, strings, bools,
// JSON nulls and absent keys in the same columns.
func mixedRows() []Row {
	return []Row{
		{"a": 10.0, "b": 4.0, "s": "foo", "flag": true, "n": nil},
		{"a": 2.5, "b": 0.0, "s": "bar", "flag": false, "n": nil},
		{"a": "oops", "b": 3.0, "s": 7.0, "flag": true}, // n absent
		{"b": 2.0, "flag": false},                       // a, s, n absent
	}
}

func evalRows(e Expr, rows []Row) []Cell {
	out := make([]Cell, len(rows))
	for i, r := range rows {
		out[i] = e.Eval(r)
	}
	return out
}

func wantValue(t *testing.T, got Cell, want any) {
	t.Helper()
	if got.State != StateValue {
		t.Fatalf("got %v, want value %v", got, want)
	}
	if got.Value != want {
		t.Fatalf("got value %v (%T), want %v (%T)", got.Value, got.Value, want, want)
	}
}

func wantState(t *testing.T, got Cell, want State) {
	t.Helper()
	if got.State != want {
		t.Fatalf("got %v (state %v), want state %v", got, got.State, want)
	}
}

func TestArithmeticPerRow(t *testing.T) {
	got := evalRows(Add(Col("a"), Col("b")), mixedRows())
	wantValue(t, got[0], 14.0)
	wantValue(t, got[1], 2.5)
	wantState(t, got[2], StateError) // "oops" + 3
	wantState(t, got[3], StateMissing)
}

func TestDivisionAndModulo(t *testing.T) {
	got := evalRows(Div(Col("a"), Col("b")), mixedRows())
	wantValue(t, got[0], 2.5)
	wantState(t, got[1], StateError) // division by zero
	if !strings.Contains(got[1].Err.Error(), "division by zero") {
		t.Fatalf("unexpected error: %v", got[1].Err)
	}
	wantState(t, got[2], StateError) // string / number
	wantState(t, got[3], StateMissing)

	wantValue(t, Mod(Lit(10.0), Lit(3.0)).Eval(Row{}), 1.0)
	wantState(t, Mod(Lit(10.0), Lit(0.0)).Eval(Row{}), StateError)
}

func TestThreeStatesIndependent(t *testing.T) {
	row := Row{"n": nil, "s": "txt", "x": 1.0}

	if got := Mul(Col("absent"), Lit(2.0)).Eval(row); got.State != StateMissing {
		t.Fatalf("missing operand: got %v, want missing", got)
	}
	if got := Mul(Col("n"), Lit(2.0)).Eval(row); got.State != StateNull {
		t.Fatalf("null operand: got %v, want null", got)
	}
	if got := Mul(Col("s"), Lit(2.0)).Eval(row); got.State != StateError {
		t.Fatalf("type mismatch: got %v, want error", got)
	}

	// The three states are distinct and propagate distinctly through if.
	if got := If(Gt(Col("absent"), Lit(0.0)), Lit(1.0), Lit(2.0)).Eval(row); got.State != StateMissing {
		t.Fatalf("missing condition: got %v, want missing", got)
	}
	if got := If(Gt(Col("n"), Lit(0.0)), Lit(1.0), Lit(2.0)).Eval(row); got.State != StateNull {
		t.Fatalf("null condition: got %v, want null", got)
	}
	if got := If(Gt(Col("s"), Lit(0.0)), Lit(1.0), Lit(2.0)).Eval(row); got.State != StateError {
		t.Fatalf("error condition: got %v, want error", got)
	}

	// Missing and null propagate without attempting arithmetic, so they
	// are never polluted by a type error on the other operand; missing
	// dominates null. Errors surface only between concrete values.
	if got := Add(Col("absent"), Col("n")).Eval(row); got.State != StateMissing {
		t.Fatalf("missing+null: got %v, want missing", got)
	}
	if got := Add(Col("n"), Col("s")).Eval(row); got.State != StateNull {
		t.Fatalf("null+mistyped: got %v, want null", got)
	}
	if got := Add(Col("absent"), Col("s")).Eval(row); got.State != StateMissing {
		t.Fatalf("missing+mistyped: got %v, want missing", got)
	}
}

func TestIfEvaluatesOnlySelectedBranch(t *testing.T) {
	rows := []Row{
		{"flag": true, "b": 4.0},
		{"flag": false, "b": 0.0}, // 10/0 would error, but else branch is chosen
		{"flag": true, "b": 0.0},  // selected branch errors: error must surface
	}
	got := evalRows(If(Col("flag"), Div(Lit(10.0), Col("b")), Lit(999.0)), rows)
	wantValue(t, got[0], 2.5)
	wantValue(t, got[1], 999.0) // unselected 10/0 must not pollute
	wantState(t, got[2], StateError)

	// Error in the then-branch, condition false: pure literal result.
	wantValue(t,
		If(Lit(false), Div(Lit(1.0), Lit(0.0)), Lit(42.0)).Eval(Row{}),
		42.0)

	// Non-bool condition is an error.
	wantState(t, If(Lit(1.0), Lit(1.0), Lit(2.0)).Eval(Row{}), StateError)
}

func TestTypeInferencePerRowNotFirstRow(t *testing.T) {
	// Column a is a number in row 0 and a string in row 2: no column-level
	// schema is derived from the first row, each row is typed on its own.
	got := evalRows(Mul(Col("a"), Lit(2.0)), mixedRows())
	wantValue(t, got[0], 20.0)
	wantValue(t, got[1], 5.0)
	wantState(t, got[2], StateError)
	wantState(t, got[3], StateMissing)

	// Same for a string column that holds a number in one row.
	got = evalRows(Add(Col("s"), Lit("!")), mixedRows())
	wantValue(t, got[0], "foo!")
	wantValue(t, got[1], "bar!")
	wantState(t, got[2], StateError) // 7 + "!"
	wantState(t, got[3], StateMissing)
}

func TestComparison(t *testing.T) {
	row := Row{"a": 10.0, "b": 4.0, "s": "foo", "n": nil}
	wantValue(t, Gt(Col("a"), Col("b")).Eval(row), true)
	wantValue(t, Le(Col("a"), Col("b")).Eval(row), false)
	wantValue(t, Eq(Col("s"), Lit("foo")).Eval(row), true)
	wantValue(t, Ne(Col("s"), Lit("foo")).Eval(row), false)
	wantValue(t, Lt(Lit("abc"), Lit("abd")).Eval(row), true)

	// Equality across different types is false, not an error.
	wantValue(t, Eq(Col("a"), Col("s")).Eval(row), false)
	wantValue(t, Ne(Col("a"), Col("s")).Eval(row), true)
	wantValue(t, Eq(Col("a"), Lit(true)).Eval(row), false)

	// Ordering across different types is an error.
	wantState(t, Lt(Col("a"), Col("s")).Eval(row), StateError)

	// Null and missing propagate through comparisons.
	wantState(t, Eq(Col("n"), Lit(1.0)).Eval(row), StateNull)
	wantState(t, Gt(Col("absent"), Lit(1.0)).Eval(row), StateMissing)
}

func TestThreeValuedLogic(t *testing.T) {
	row := Row{"flag": true, "n": nil}

	// Short-circuit: decisive left operand skips the erroring right side.
	wantValue(t, And(Lit(false), Gt(Div(Lit(1.0), Lit(0.0)), Lit(0.0))).Eval(row), false)
	wantValue(t, Or(Lit(true), Gt(Div(Lit(1.0), Lit(0.0)), Lit(0.0))).Eval(row), true)

	// Concrete results.
	wantValue(t, And(Col("flag"), Lit(true)).Eval(row), true)
	wantValue(t, Or(Col("flag"), Lit(false)).Eval(row), true)
	wantValue(t, Not(Col("flag")).Eval(row), false)

	// Unknown propagation.
	wantState(t, And(Col("absent"), Lit(true)).Eval(row), StateMissing)
	wantState(t, Or(Col("n"), Lit(false)).Eval(row), StateNull)
	wantState(t, Not(Col("n")).Eval(row), StateNull)
	wantState(t, Not(Col("absent")).Eval(row), StateMissing)

	// Unknown combined with a decisive concrete value.
	wantValue(t, And(Col("n"), Lit(false)).Eval(row), false)
	wantValue(t, Or(Col("n"), Lit(true)).Eval(row), true)

	// Non-bool operands are errors.
	wantState(t, And(Lit(1.0), Lit(true)).Eval(row), StateError)
	wantState(t, Not(Lit("x")).Eval(row), StateError)
}

func TestParseExpr(t *testing.T) {
	row := Row{"x": 3.0, "s": "hi", "flag": true, "n": nil}
	cases := []struct {
		src   string
		want  any   // expected value when state is StateValue
		state State // zero value (StateValue) unless set
	}{
		{"1 + 2 * 3", 7.0, StateValue},
		{"(1 + 2) * 3", 9.0, StateValue},
		{"x * 2 + 1", 7.0, StateValue},
		{"-x", -3.0, StateValue},
		{"- x + 4", 1.0, StateValue},
		{"10 % 3", 1.0, StateValue},
		{"1.5e2", 150.0, StateValue},
		{"x >= 3 and flag", true, StateValue},
		{"x > 3 or flag", true, StateValue},
		{"not flag", false, StateValue},
		{"not (x == 3)", false, StateValue},
		{`if(x > 1, "big", "small")`, "big", StateValue},
		{`if(x < 1, "big", "small")`, "small", StateValue},
		{`s + "!"`, "hi!", StateValue},
		{"x == 3", true, StateValue},
		{"x != 3", false, StateValue},
		{"null", nil, StateNull},
		{"missing_col", nil, StateMissing},
		{"x / 0", nil, StateError},
		{"n + 1", nil, StateNull},
		// Laziness through the parser: the unselected branch divides by zero.
		{`if(flag, x, 1 / 0)`, 3.0, StateValue},
		{`if(not flag, 1 / 0, x)`, 3.0, StateValue},
	}
	for _, c := range cases {
		e, err := ParseExpr(c.src)
		if err != nil {
			t.Fatalf("ParseExpr(%q): %v", c.src, err)
		}
		got := e.Eval(row)
		if got.State != c.state {
			t.Fatalf("%s: got %v, want state %v", c.src, got, c.state)
		}
		if c.state == StateValue && got.Value != c.want {
			t.Fatalf("%s: got %v, want %v", c.src, got.Value, c.want)
		}
	}
}

func TestParseExprErrors(t *testing.T) {
	for _, src := range []string{
		"", "1 +", "if(x, 1)", "if x, 1, 2)", "(1", "1 2", "x = 1",
		"!x", "@", `"unterminated`, "1 .. 2",
	} {
		if _, err := ParseExpr(src); err == nil {
			t.Fatalf("ParseExpr(%q): expected error, got nil", src)
		}
	}
}

// TestComputeJSONTable is the end-to-end reference check: a JSON table
// with mixed types, nulls and absent keys is interpreted row by row and
// every result cell is verified against hand-computed expectations.
func TestComputeJSONTable(t *testing.T) {
	const doc = `[
		{"price": 10, "qty": 2, "discount": null},
		{"price": "n/a", "qty": 3},
		{"qty": 4, "discount": 0.1}
	]`
	rows, err := ParseTable(strings.NewReader(doc))
	if err != nil {
		t.Fatalf("ParseTable: %v", err)
	}

	mustParse := func(src string) Expr {
		e, err := ParseExpr(src)
		if err != nil {
			t.Fatalf("ParseExpr(%q): %v", src, err)
		}
		return e
	}

	out := Compute(rows,
		Column{Name: "total", Expr: mustParse("price * qty")},
		Column{Name: "label", Expr: mustParse(`if(qty > 2, "bulk", "small")`)},
		Column{Name: "note", Expr: mustParse("discount + 1")},
	)
	if len(out) != 3 {
		t.Fatalf("got %d result rows, want 3", len(out))
	}

	// Row 0: all inputs present.
	wantValue(t, out[0]["total"], 20.0)
	wantValue(t, out[0]["label"], "small")
	wantState(t, out[0]["note"], StateNull) // null + 1 stays null

	// Row 1: price is a string, discount key absent.
	wantState(t, out[1]["total"], StateError)
	wantValue(t, out[1]["label"], "bulk")
	wantState(t, out[1]["note"], StateMissing)

	// Row 2: price key absent, discount present.
	wantState(t, out[2]["total"], StateMissing)
	wantValue(t, out[2]["label"], "bulk")
	wantValue(t, out[2]["note"], 1.1)
}

func TestParseTableErrors(t *testing.T) {
	if _, err := ParseTable(strings.NewReader(`{"not":"an array"}`)); err == nil {
		t.Fatal("expected error for non-array JSON")
	}
	if _, err := ParseTable(strings.NewReader(`[1, 2]`)); err == nil {
		t.Fatal("expected error for non-object rows")
	}
	if _, err := ParseTable(strings.NewReader(`[broken`)); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestCellString(t *testing.T) {
	cases := map[Cell]string{
		Value(2.5):            "2.5",
		Value("x"):            "x",
		Value(true):           "true",
		Missing():             "<missing>",
		Null():                "<null>",
		errorf("boom: %d", 1): "<error: boom: 1>",
	}
	for c, want := range cases {
		if got := c.String(); got != want {
			t.Fatalf("Cell.String() = %q, want %q", got, want)
		}
	}
}
