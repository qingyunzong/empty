package colcalc

import (
	"fmt"
	"math/rand"
	"testing"
)

// refEval is an independent reference interpreter, written as plainly
// as possible straight from the semantics:
//   - states error > missing > null propagate through operators;
//   - If evaluates only the selected branch.
//
// The randomized tests below check the main evaluator against this
// reference row by row over mixed inputs.
func refEval(e Expr, r Row) Value {
	switch ex := e.(type) {
	case Lit:
		return ex.V
	case Col:
		v, ok := r[ex.Name]
		if !ok {
			return Value{Kind: Missing}
		}
		return FromJSON(v)
	case If:
		c := refEval(ex.Cond, r)
		if c.Kind == Bool {
			if c.B {
				return refEval(ex.Then, r)
			}
			return refEval(ex.Else, r)
		}
		if c.Kind == Null || c.Kind == Missing || c.Kind == Error {
			return c
		}
		return Errv("if condition must be bool, got %s", c.Kind)
	case Not:
		v := refEval(ex.E, r)
		if v.Kind == Bool {
			return Boolv(!v.B)
		}
		if v.Kind == Error || v.Kind == Missing || v.Kind == Null {
			return v
		}
		return Errv("not: bad operand type %s", v.Kind)
	case Pred:
		v := refEval(ex.E, r)
		switch ex.Kind {
		case IsNull:
			return Boolv(v.Kind == Null)
		case IsMissing:
			return Boolv(v.Kind == Missing)
		case IsError:
			return Boolv(v.Kind == Error)
		}
	case Arith:
		l, rr := refEval(ex.L, r), refEval(ex.R, r)
		if s, stop := refState(l, rr); stop {
			return s
		}
		if l.Kind != Number || rr.Kind != Number {
			return Errv("arithmetic on %s and %s", l.Kind, rr.Kind)
		}
		switch ex.Op {
		case Add:
			return Numv(l.Num + rr.Num)
		case Sub:
			return Numv(l.Num - rr.Num)
		case Mul:
			return Numv(l.Num * rr.Num)
		case Div:
			if rr.Num == 0 {
				return Errv("division by zero")
			}
			return Numv(l.Num / rr.Num)
		}
	case Cmp:
		l, rr := refEval(ex.L, r), refEval(ex.R, r)
		if s, stop := refState(l, rr); stop {
			return s
		}
		if l.Kind != rr.Kind {
			return Errv("cannot compare %s with %s", l.Kind, rr.Kind)
		}
		switch l.Kind {
		case Number:
			return refCmpOrdered(ex.Op, l.Num, rr.Num)
		case String:
			return refCmpOrdered(ex.Op, l.Str, rr.Str)
		case Bool:
			if ex.Op == Eq {
				return Boolv(l.B == rr.B)
			}
			if ex.Op == Ne {
				return Boolv(l.B != rr.B)
			}
			return Errv("booleans only support == and !=")
		}
		return Errv("cannot compare kind %s", l.Kind)
	case Logic:
		l := refEval(ex.L, r)
		if ex.Op == And && l.Kind == Bool && !l.B {
			return Boolv(false)
		}
		if ex.Op == Or && l.Kind == Bool && l.B {
			return Boolv(true)
		}
		rr := refEval(ex.R, r)
		if s, stop := refState(l, rr); stop {
			return s
		}
		if l.Kind != Bool || rr.Kind != Bool {
			return Errv("logic on %s and %s", l.Kind, rr.Kind)
		}
		if ex.Op == And {
			return Boolv(l.B && rr.B)
		}
		return Boolv(l.B || rr.B)
	}
	return Errv("unknown expression %T", e)
}

func refState(l, r Value) (Value, bool) {
	if l.Kind == Error {
		return l, true
	}
	if r.Kind == Error {
		return r, true
	}
	if l.Kind == Missing || r.Kind == Missing {
		return Missingv(), true
	}
	if l.Kind == Null || r.Kind == Null {
		return Nullv(), true
	}
	return Value{}, false
}

func refCmpOrdered[T float64 | string](op CmpOp, l, r T) Value {
	switch op {
	case Eq:
		return Boolv(l == r)
	case Ne:
		return Boolv(l != r)
	case Lt:
		return Boolv(l < r)
	case Le:
		return Boolv(l <= r)
	case Gt:
		return Boolv(l > r)
	case Ge:
		return Boolv(l >= r)
	}
	return Errv("unknown comparison op")
}

// --- random generators for mixed inputs ---

var colPool = []string{"a", "b", "c", "d"}

func genScalar(rg *rand.Rand) any {
	switch rg.Intn(6) {
	case 0:
		return nil
	case 1:
		return float64(rg.Intn(5) - 2) // small ints incl. 0 (div-by-zero)
	case 2:
		return rg.Float64() * 10
	case 3:
		return []string{"x", "y", "hello"}[rg.Intn(3)]
	case 4:
		return rg.Intn(2) == 0
	default:
		return float64(rg.Intn(100))
	}
}

func genRow(rg *rand.Rand) Row {
	r := Row{}
	for _, k := range colPool {
		if rg.Intn(10) < 7 { // 30% of keys absent -> missing
			r[k] = genScalar(rg)
		}
	}
	return r
}

func genExpr(rg *rand.Rand, depth int) Expr {
	if depth <= 0 {
		switch rg.Intn(3) {
		case 0:
			return Col{colPool[rg.Intn(len(colPool))]}
		case 1:
			return Lit{FromJSON(genScalar(rg))}
		default:
			return Lit{Numv(float64(rg.Intn(4)))}
		}
	}
	sub := func() Expr { return genExpr(rg, depth-1) }
	switch rg.Intn(8) {
	case 0:
		return Arith{ArithOp(rg.Intn(4)), sub(), sub()}
	case 1:
		return Cmp{CmpOp(rg.Intn(6)), sub(), sub()}
	case 2:
		return If{sub(), sub(), sub()}
	case 3:
		return Logic{LogicOp(rg.Intn(2)), sub(), sub()}
	case 4:
		return Not{sub()}
	case 5:
		return Pred{PredKind(rg.Intn(3)), sub()}
	default:
		return sub()
	}
}

// TestEvalMatchesReference cross-checks the evaluator against the
// reference interpreter row by row over randomly generated mixed
// inputs: numbers, strings, bools, nulls and absent keys.
func TestEvalMatchesReference(t *testing.T) {
	rg := rand.New(rand.NewSource(20261006))
	const iterations = 50000
	for i := 0; i < iterations; i++ {
		expr := genExpr(rg, 4)
		row := genRow(rg)
		got := Eval(expr, row)
		want := refEval(expr, row)
		if !Equal(got, want) {
			t.Fatalf("iter %d: expr=%#v row=%v\ngot  %v\nwant %v", i, expr, row, got, want)
		}
	}
}

// TestIfNeverEvaluatesUnselectedBranch proves laziness structurally:
// for random rows, an If whose unselected branch is a guaranteed error
// must still produce the selected branch's value.
func TestIfNeverEvaluatesUnselectedBranch(t *testing.T) {
	rg := rand.New(rand.NewSource(7))
	poison := Arith{Div, Lit{Numv(1)}, Lit{Numv(0)}}
	for i := 0; i < 10000; i++ {
		row := genRow(rg)
		cond := genExpr(rg, 3)
		c := refEval(cond, row)
		if c.Kind != Bool {
			continue
		}
		var expr Expr
		var want Value
		if c.B {
			expr = If{cond, Lit{Numv(1)}, poison}
			want = Numv(1)
		} else {
			expr = If{cond, poison, Lit{Numv(2)}}
			want = Numv(2)
		}
		if got := Eval(expr, row); !Equal(got, want) {
			t.Fatalf("iter %d: unselected branch polluted result: got %v, want %v (row %v)", i, got, want, row)
		}
	}
}

// TestPerRowInferenceMixedInput checks per-row kind inference against
// kinds computed by the reference interpreter, on mixed JSON tables.
func TestPerRowInferenceMixedInput(t *testing.T) {
	rg := rand.New(rand.NewSource(99))
	for trial := 0; trial < 2000; trial++ {
		n := 1 + rg.Intn(8)
		tab := make(Table, n)
		for i := range tab {
			tab[i] = genRow(rg)
		}
		expr := genExpr(rg, 3)
		kinds := tab.InferKinds(expr)
		if len(kinds) != n {
			t.Fatalf("got %d kinds for %d rows", len(kinds), n)
		}
		for i, row := range tab {
			if want := refEval(expr, row).Kind; kinds[i] != want {
				t.Fatalf("trial %d row %d: got kind %v, want %v", trial, i, kinds[i], want)
			}
		}
	}
}

func ExampleTable_Compute() {
	tab, _ := ParseTable([]byte(`[{"a":1,"b":2},{"a":null,"b":2},{"b":3}]`))
	for _, v := range tab.Compute(Arith{Add, Col{"a"}, Col{"b"}}) {
		fmt.Println(v)
	}
	// Output:
	// number(3)
	// null
	// missing
}
