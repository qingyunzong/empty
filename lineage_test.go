package dataeng

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

func ExampleCompile() {
	x := Var("x")
	y := Var("y")
	shared := Union(x, y)
	square := Join(shared, shared)

	poly, err := Compile(square, 10)
	if err != nil {
		panic(err)
	}
	fmt.Println(poly)
	// Output: y^2 + 2*x*y + x^2
}

func makeTerm(coefficient int64, exponents ...int) Term {
	return Term{
		Exponents:   exponents,
		Coefficient: *big.NewInt(coefficient),
	}
}

func assertPolynomialEqual(t *testing.T, got, want *Polynomial) {
	t.Helper()
	if !got.Equal(want) {
		t.Fatalf("polynomial mismatch\n got: %s\ngot struct: %#v\nwant: %s\nwant struct: %#v",
			got, got, want, want)
	}
}

func TestVariableIDValidation(t *testing.T) {
	valid := []string{"x", "用户", "a b", "😀", "\u00e9", "-"}
	for _, id := range valid {
		if err := ValidateVariableID(id); err != nil {
			t.Fatalf("ValidateVariableID(%q) = %v", id, err)
		}
		expr, err := NewVar(id)
		if err != nil {
			t.Fatalf("NewVar(%q) = %v", id, err)
		}
		if expr.VariableID() != id {
			t.Fatalf("NewVar(%q).VariableID() = %q", id, expr.VariableID())
		}
	}

	if err := ValidateVariableID(""); !errors.Is(err, ErrEmptyVariableID) {
		t.Fatalf("empty ID error = %v, want ErrEmptyVariableID", err)
	}
	if err := ValidateVariableID("\xff"); !errors.Is(err, ErrInvalidUTF8) {
		t.Fatalf("invalid UTF-8 error = %v, want ErrInvalidUTF8", err)
	}
	if _, err := NewVar("\xff"); !errors.Is(err, ErrInvalidUTF8) {
		t.Fatalf("NewVar invalid UTF-8 error = %v, want ErrInvalidUTF8", err)
	}

	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("Var with an invalid ID did not panic")
		}
		err, ok := recovered.(error)
		if !ok || !errors.Is(err, ErrInvalidUTF8) {
			t.Fatalf("panic value = %#v, want ErrInvalidUTF8", recovered)
		}
	}()
	Var("\xff")
}

func TestNilExpressionRejected(t *testing.T) {
	if _, err := NewUnion(Var("x"), nil); !errors.Is(err, ErrNilExpression) {
		t.Fatalf("NewUnion nil error = %v", err)
	}
	if _, err := NewJoin(Var("x"), nil); !errors.Is(err, ErrNilExpression) {
		t.Fatalf("NewJoin nil error = %v", err)
	}
	if _, err := Compile(nil); !errors.Is(err, ErrNilExpression) {
		t.Fatalf("Compile(nil) error = %v", err)
	}
}

func TestCycleDetected(t *testing.T) {
	node := &Expr{kind: KindUnion}
	node.args = []*Expr{node}
	if err := Validate(node); !errors.Is(err, ErrCycle) {
		t.Fatalf("Validate cycle error = %v, want ErrCycle", err)
	}
	if _, err := Compile(node); !errors.Is(err, ErrCycle) {
		t.Fatalf("Compile cycle error = %v, want ErrCycle", err)
	}
}

func TestExponentOverflowDetected(t *testing.T) {
	if _, err := addExponents([]int{math.MaxInt}, []int{1}); !errors.Is(err, ErrExponentOverflow) {
		t.Fatalf("addExponents overflow error = %v, want ErrExponentOverflow", err)
	}

	expr := Var("x")
	for i := 0; i < 62; i++ {
		expr = Join(expr, expr)
	}
	if _, err := Compile(Join(expr, expr), Unlimited); !errors.Is(err, ErrExponentOverflow) {
		t.Fatalf("deep exponent overflow error = %v, want ErrExponentOverflow", err)
	}
}

func TestUnionAccumulatesCoefficients(t *testing.T) {
	x := Var("x")
	got, err := Compile(Union(x, x, x))
	if err != nil {
		t.Fatal(err)
	}
	want := &Polynomial{
		Variables: []string{"x"},
		Terms:     []Term{makeTerm(3, 1)},
	}
	assertPolynomialEqual(t, got, want)

	// A repeated non-leaf source accumulates as a repeated polynomial.
	sum := Join(x, Var("y"))
	got, err = Compile(Union(sum, sum))
	if err != nil {
		t.Fatal(err)
	}
	want = &Polynomial{
		Variables: []string{"x", "y"},
		Terms:     []Term{makeTerm(2, 1, 1)},
	}
	assertPolynomialEqual(t, got, want)
}

func TestJoinPreservesMultiplicity(t *testing.T) {
	x := Var("x")
	got, err := Compile(Join(x, x))
	if err != nil {
		t.Fatal(err)
	}
	want := &Polynomial{
		Variables: []string{"x"},
		Terms:     []Term{makeTerm(1, 2)},
	}
	assertPolynomialEqual(t, got, want)

	got, err = Compile(Join(x, x, x))
	if err != nil {
		t.Fatal(err)
	}
	want = &Polynomial{
		Variables: []string{"x"},
		Terms:     []Term{makeTerm(1, 3)},
	}
	assertPolynomialEqual(t, got, want)
}

func TestBinomialExpansion(t *testing.T) {
	sum := Union(Var("x"), Var("y"))
	got, err := Compile(Join(sum, sum))
	if err != nil {
		t.Fatal(err)
	}
	// Terms are in ascending lexicographic exponent order:
	// y^2, xy, x^2 for variables [x y].
	want := &Polynomial{
		Variables: []string{"x", "y"},
		Terms: []Term{
			makeTerm(1, 0, 2),
			makeTerm(2, 1, 1),
			makeTerm(1, 2, 0),
		},
	}
	assertPolynomialEqual(t, got, want)
}

func TestCanonicalVariableAndTermOrder(t *testing.T) {
	expr := Union(Var("y"), Var("x"), Var("用户"), Var("y"), Join(Var("x"), Var("用户")))
	got, err := Compile(expr)
	if err != nil {
		t.Fatal(err)
	}
	wantVariables := []string{"x", "y", "用户"}
	if len(got.Variables) != len(wantVariables) {
		t.Fatalf("variables = %#v, want %#v", got.Variables, wantVariables)
	}
	for i := range wantVariables {
		if got.Variables[i] != wantVariables[i] {
			t.Fatalf("variables = %#v, want %#v", got.Variables, wantVariables)
		}
	}
	if !sort.SliceIsSorted(got.Terms, func(i, j int) bool {
		return CompareExponents(got.Terms[i].Exponents, got.Terms[j].Exponents) < 0
	}) {
		t.Fatalf("terms are not lexicographically sorted: %#v", got.Terms)
	}
	for i := 1; i < len(got.Terms); i++ {
		if CompareExponents(got.Terms[i-1].Exponents, got.Terms[i].Exponents) == 0 {
			t.Fatalf("duplicate exponent vectors at terms %d and %d", i-1, i)
		}
	}
	for _, term := range got.Terms {
		if term.Coefficient.Sign() < 0 {
			t.Fatalf("negative coefficient: %s", term.Coefficient.String())
		}
		if term.Coefficient.Sign() == 0 {
			t.Fatalf("zero term was not removed: %#v", term)
		}
	}
}

func TestVariablesAndValidate(t *testing.T) {
	expr := Join(Union(Var("b"), Var("a")), Var("c"))
	variables, err := Variables(expr)
	if err != nil {
		t.Fatal(err)
	}
	if len(variables) != 3 || variables[0] != "a" || variables[1] != "b" || variables[2] != "c" {
		t.Fatalf("variables = %#v", variables)
	}
	if err := Validate(expr); err != nil {
		t.Fatalf("Validate = %v", err)
	}
}

func TestArbitraryPrecisionCoefficients(t *testing.T) {
	expr := Var("x")
	for i := 0; i < 130; i++ {
		expr = Union(expr, expr)
	}
	got, err := Compile(expr)
	if err != nil {
		t.Fatal(err)
	}
	want := new(big.Int).Lsh(big.NewInt(1), 130)
	if len(got.Terms) != 1 || got.Terms[0].Coefficient.Cmp(want) != 0 {
		t.Fatalf("coefficient = %#v, want %s", got.Terms, want)
	}
}

func TestZeroAndIdentitySimplification(t *testing.T) {
	tests := []struct {
		name string
		expr *Expr
	}{
		{"union of zero", Union(Zero(), Zero())},
		{"join with zero", Join(Zero(), Join(Var("x"), Var("y")))},
		{"nested zero", Join(Union(Zero(), Zero()), Var("x"))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Compile(test.expr)
			if err != nil {
				t.Fatal(err)
			}
			if !got.IsZero() || len(got.Variables) != 0 || len(got.Terms) != 0 {
				t.Fatalf("got %#v, want canonical zero polynomial", got)
			}
		})
	}

	got, err := Compile(Join(One(), Var("x")))
	if err != nil {
		t.Fatal(err)
	}
	assertPolynomialEqual(t, got, &Polynomial{
		Variables: []string{"x"},
		Terms:     []Term{makeTerm(1, 1)},
	})
}

func TestSharedSubexpressionDAGEvaluation(t *testing.T) {
	x := Var("x")
	y := Var("y")
	shared := Union(x, y)
	square := Join(shared, shared)
	root := Union(Join(square, shared), Join(square, x))

	got, err := Compile(root)
	if err != nil {
		t.Fatal(err)
	}

	for _, assignment := range []map[string]int64{
		{"x": 0, "y": 0},
		{"x": 1, "y": 2},
		{"x": -2, "y": 3},
		{"x": 7, "y": -5},
	} {
		wantValue := evaluateExprBig(t, root, assignment)
		gotValue, err := got.EvaluateInt(assignment)
		if err != nil {
			t.Fatal(err)
		}
		if gotValue.Cmp(wantValue) != 0 {
			t.Fatalf("assignment %#v: polynomial value %s, DAG value %s",
				assignment, gotValue, wantValue)
		}
	}
}

func TestDistributivity(t *testing.T) {
	a := Union(Var("a"), Var("b"))
	b := Join(Var("b"), Var("c"))
	c := Union(Var("d"), One())

	left, err := Compile(Join(a, Union(b, c)))
	if err != nil {
		t.Fatal(err)
	}
	right, err := Compile(Union(Join(a, b), Join(a, c)))
	if err != nil {
		t.Fatal(err)
	}
	assertPolynomialEqual(t, left, right)

	// The same identity must hold numerically on the shared DAG as well.
	for _, assignment := range []map[string]int64{
		{"a": 1, "b": 2, "c": 3, "d": 4},
		{"a": -1, "b": 5, "c": -2, "d": 0},
	} {
		leftValue := evaluateExprBig(t, Join(a, Union(b, c)), assignment)
		rightValue := evaluateExprBig(t, Union(Join(a, b), Join(a, c)), assignment)
		if leftValue.Cmp(rightValue) != 0 {
			t.Fatalf("assignment %#v: left = %s, right = %s",
				assignment, leftValue, rightValue)
		}
	}
}

func TestBudgetIsClosedOrFails(t *testing.T) {
	variables := []*Expr{Var("a"), Var("b"), Var("c"), Var("d")}
	square := Join(Union(variables...), Union(variables...))

	got, err := Compile(square, 10)
	if err != nil {
		t.Fatalf("budget 10 failed: %v", err)
	}
	if len(got.Terms) != 10 {
		t.Fatalf("got %d terms, want 10", len(got.Terms))
	}

	got, err = Compile(square, 9)
	if !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("budget 9 error = %v, want ErrBudgetExceeded", err)
	}
	if got != nil {
		t.Fatalf("budget failure returned a partial polynomial: %#v", got)
	}
	var budgetErr *BudgetError
	if !errors.As(err, &budgetErr) {
		t.Fatalf("budget 9 error type = %T, want *BudgetError", err)
	}
	if budgetErr.Limit != 9 || budgetErr.Observed <= 9 {
		t.Fatalf("budget error = %#v", budgetErr)
	}

	zero, err := Compile(Zero(), 0)
	if err != nil {
		t.Fatalf("zero polynomial with budget 0 failed: %v", err)
	}
	if !zero.IsZero() {
		t.Fatalf("got %#v, want zero", zero)
	}
	if _, err := Compile(One(), 0); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("constant 1 with budget 0 error = %v, want ErrBudgetExceeded", err)
	}
	if _, err := Compile(square, -2); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("budget -2 error = %v, want ErrInvalidBudget", err)
	}
	if _, err := Compile(square, Unlimited); err != nil {
		t.Fatalf("unlimited budget failed: %v", err)
	}
	if _, err := Compile(square, 1, 2); !errors.Is(err, ErrInvalidBudget) {
		t.Fatalf("multiple budgets error = %v, want ErrInvalidBudget", err)
	}
}

func TestCompileOptionsBudget(t *testing.T) {
	expr := Join(Union(Var("x"), Var("y")), Union(Var("x"), Var("y")))
	if _, err := CompileOptions(expr, Options{MaxTerms: 2}); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("CompileOptions budget error = %v", err)
	}
	poly, err := CompileOptions(expr, Options{MaxTerms: 3})
	if err != nil {
		t.Fatal(err)
	}
	if poly.TermCount() != 3 {
		t.Fatalf("term count = %d, want 3", poly.TermCount())
	}
}

func TestEvaluateMissingVariable(t *testing.T) {
	poly, err := Compile(Var("x"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := poly.EvaluateInt(map[string]int64{}); err == nil {
		t.Fatal("EvaluateInt succeeded without assigning x")
	} else {
		var missing *MissingVariableError
		if !errors.As(err, &missing) || missing.ID != "x" {
			t.Fatalf("error = %#v, want MissingVariableError for x", err)
		}
	}
}

func TestPolynomialCloneEqualAndString(t *testing.T) {
	poly, err := Compile(Union(One(), Var("x"), Join(Var("x"), Var("x"))))
	if err != nil {
		t.Fatal(err)
	}
	clone := poly.Clone()
	if !poly.Equal(clone) {
		t.Fatalf("clone is not equal: %#v vs %#v", poly, clone)
	}
	clone.Terms[0].Coefficient.SetInt64(99)
	if poly.Equal(clone) {
		t.Fatal("mutating clone changed equality")
	}
	if got := poly.String(); got == "" || got == "0" {
		t.Fatalf("String() = %q", got)
	}
}

func TestDuplicateDAGEdgesAreMemoizedSemantically(t *testing.T) {
	x := Var("x")
	y := Var("y")
	pair := Join(x, y)
	root := Union(pair, pair, pair, pair, pair)
	got, err := Compile(root)
	if err != nil {
		t.Fatal(err)
	}
	assertPolynomialEqual(t, got, &Polynomial{
		Variables: []string{"x", "y"},
		Terms:     []Term{makeTerm(5, 1, 1)},
	})
}

func TestDeepSharedDAGDoesNotExpandAsTree(t *testing.T) {
	shared := Union(Var("x"), Var("y"))
	for i := 0; i < 10; i++ {
		shared = Join(shared, shared)
	}

	poly, err := Compile(shared, 1025)
	if err != nil {
		t.Fatal(err)
	}
	if poly.TermCount() != 1025 {
		t.Fatalf("term count = %d, want 1025", poly.TermCount())
	}
	if _, err := Compile(shared, 1024); !errors.Is(err, ErrBudgetExceeded) {
		t.Fatalf("budget 1024 error = %v, want ErrBudgetExceeded", err)
	}

	value, err := poly.EvaluateInt(map[string]int64{"x": 1, "y": 1})
	if err != nil {
		t.Fatal(err)
	}
	want := new(big.Int).Lsh(big.NewInt(1), 1024)
	if value.Cmp(want) != 0 {
		t.Fatalf("value at (1,1) = %s, want %s", value, want)
	}
	value, err = poly.EvaluateInt(map[string]int64{"x": 1, "y": 0})
	if err != nil {
		t.Fatal(err)
	}
	if value.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("value at (1,0) = %s, want 1", value)
	}
}

func TestRandomDAGEvaluationAgreement(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	ids := []string{"x0", "x1", "x2", "x3", "x4"}

	for trial := 0; trial < 200; trial++ {
		nodes := make([]*Expr, 0, 24)
		for i := 0; i < 5; i++ {
			nodes = append(nodes, Var(ids[i]))
		}
		target := 12 + rng.Intn(13)
		for len(nodes) < target {
			var node *Expr
			switch rng.Intn(10) {
			case 0:
				node = Var(ids[rng.Intn(len(ids))])
			case 1:
				node = One()
			case 2:
				node = Zero()
			default:
				count := 2 + rng.Intn(2)
				parts := make([]*Expr, count)
				for i := range parts {
					parts[i] = nodes[rng.Intn(len(nodes))]
				}
				if rng.Intn(2) == 0 {
					node = Union(parts...)
				} else {
					node = Join(parts...)
				}
			}
			nodes = append(nodes, node)
		}
		root := nodes[len(nodes)-1]

		const budget = 2000
		poly, err := Compile(root, budget)
		if err != nil {
			if errors.Is(err, ErrBudgetExceeded) {
				if poly != nil {
					t.Fatalf("trial %d returned a polynomial on budget failure", trial)
				}
				continue
			}
			t.Fatalf("trial %d compile failed: %v", trial, err)
		}
		checkCanonical(t, trial, poly)

		assignment := make(map[string]int64, len(ids))
		for _, id := range ids {
			assignment[id] = int64(rng.Intn(7) - 3)
		}
		got, err := poly.EvaluateInt(assignment)
		if err != nil {
			t.Fatalf("trial %d evaluation failed: %v", trial, err)
		}
		want := evaluateExprBig(t, root, assignment)
		if got.Cmp(want) != 0 {
			t.Fatalf("trial %d assignment %#v: polynomial = %s, DAG = %s",
				trial, assignment, got, want)
		}

		if poly.TermCount() > 0 {
			if _, err := Compile(root, poly.TermCount()-1); !errors.Is(err, ErrBudgetExceeded) {
				t.Fatalf("trial %d with %d terms accepted budget %d: %v",
					trial, poly.TermCount(), poly.TermCount()-1, err)
			}
		}
	}
}

func checkCanonical(t *testing.T, trial int, poly *Polynomial) {
	t.Helper()
	if !sort.StringsAreSorted(poly.Variables) {
		t.Fatalf("trial %d variables are not sorted: %#v", trial, poly.Variables)
	}
	if !sort.SliceIsSorted(poly.Terms, func(i, j int) bool {
		return CompareExponents(poly.Terms[i].Exponents, poly.Terms[j].Exponents) < 0
	}) {
		t.Fatalf("trial %d terms are not sorted", trial)
	}
	for i, term := range poly.Terms {
		if len(term.Exponents) != len(poly.Variables) {
			t.Fatalf("trial %d term %d has %d exponents for %d variables",
				trial, i, len(term.Exponents), len(poly.Variables))
		}
		if term.Coefficient.Sign() <= 0 {
			t.Fatalf("trial %d term %d has non-positive coefficient %s",
				trial, i, term.Coefficient.String())
		}
		if i > 0 && CompareExponents(poly.Terms[i-1].Exponents, term.Exponents) == 0 {
			t.Fatalf("trial %d terms %d and %d have equal exponent vectors", trial, i-1, i)
		}
	}
}

// evaluateExprBig evaluates the DAG directly at the supplied assignment. It
// shares results by node pointer, mirroring the host's shared DAG.
func evaluateExprBig(t *testing.T, expr *Expr, assignment map[string]int64) *big.Int {
	t.Helper()
	memo := make(map[*Expr]*big.Int)
	var eval func(*Expr) *big.Int
	eval = func(node *Expr) *big.Int {
		if value, ok := memo[node]; ok {
			return value
		}
		var value *big.Int
		switch node.Kind() {
		case KindVar:
			assigned, ok := assignment[node.VariableID()]
			if !ok {
				t.Fatalf("test assignment lacks %q", node.VariableID())
			}
			value = big.NewInt(assigned)
		case KindZero:
			value = new(big.Int)
		case KindOne:
			value = big.NewInt(1)
		case KindUnion:
			value = new(big.Int)
			for _, child := range node.Children() {
				value.Add(value, eval(child))
			}
		case KindJoin:
			value = big.NewInt(1)
			for _, child := range node.Children() {
				value.Mul(value, eval(child))
			}
		default:
			t.Fatalf("invalid expression node %#v", node)
		}
		memo[node] = value
		return value
	}
	return eval(expr)
}
