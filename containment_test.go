package dataeng_test

import (
	"strings"
	"testing"

	dq "example.org/dataeng/q0294"
)

func TestProjectionContainmentAndReverseFailure(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)

	problem := dq.Problem{Schema: schema, A: a, B: b}
	contained := mustCheck(t, problem, dq.Unlimited)
	requireContained(t, contained, 1)
	if len(contained.Mapping) != 1 {
		t.Fatalf("mapping length = %d, want 1", len(contained.Mapping))
	}
	if target := mappingTarget(t, contained.Mapping, "x"); target != dq.Var("x") {
		t.Fatalf("x maps to %v, want var(x)", target)
	}

	reversed := mustCheck(t, problem.Reverse(), dq.Unlimited)
	requireNotContained(t, reversed, 1)
	verifyCounterexample(t, b, a, reversed.Counterexample)

	// The minimal construction refuting B contained in A is exactly one R
	// fact on a fresh symbol; S is absent and therefore empty.
	if got := len(relationRows(reversed.Counterexample.Database, "R")); got != 1 {
		t.Fatalf("counterexample R has %d rows, want 1", got)
	}
	if got := len(relationRows(reversed.Counterexample.Database, "S")); got != 0 {
		t.Fatalf("counterexample S has %d rows, want 0", got)
	}
	if len(reversed.Counterexample.Head) != 1 || !reversed.Counterexample.Head[0].IsFresh() {
		t.Fatalf("counterexample head = %v, want one fresh symbol", reversed.Counterexample.Head)
	}
}

func TestSelfJoinMergesVariables(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 2})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}

	contained := mustCheck(t, problem, dq.Unlimited)
	requireContained(t, contained, 2)
	if target := mappingTarget(t, contained.Mapping, "x"); target != dq.Var("x") {
		t.Fatalf("x maps to %v, want var(x)", target)
	}
	if target := mappingTarget(t, contained.Mapping, "y"); target != dq.Var("x") {
		t.Fatalf("y maps to %v, want merged target var(x)", target)
	}

	reversed := mustCheck(t, problem.Reverse(), dq.Unlimited)
	requireNotContained(t, reversed, -1)
	verifyCounterexample(t, b, a, reversed.Counterexample)
}

func TestConstantsAreFixedAndByteEqual(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 2})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}

	contained := mustCheck(t, problem, dq.Unlimited)
	requireContained(t, contained, 3)
	if target := mappingTarget(t, contained.Mapping, "x"); target != dq.Var("x") {
		t.Fatalf("x maps to %v, want var(x)", target)
	}
	if target := mappingTarget(t, contained.Mapping, "y"); target != dq.Const("a") {
		t.Fatalf("y maps to %v, want fixed constant a", target)
	}

	reversed := mustCheck(t, problem.Reverse(), dq.Unlimited)
	requireNotContained(t, reversed, -1)
	verifyCounterexample(t, b, a, reversed.Counterexample)

	// Byte equality: these two UTF-8 spellings are distinct constants.
	composed := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("é")),
	)
	decomposed := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("e\u0301")),
	)
	byteProblem := dq.Problem{Schema: schema, A: composed, B: decomposed}
	if got := mustCheck(t, byteProblem, dq.Unlimited); got.Status != dq.NotContained {
		t.Fatalf("composed vs decomposed constant status = %v, want not-contained", got.Status)
	} else {
		verifyCounterexample(t, composed, decomposed, got.Counterexample)
	}
}

func TestRepeatedHeadPositionsMustAgree(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x"), dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x"), dq.Var("y")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("R", dq.Var("y")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}

	contained := mustCheck(t, problem, dq.Unlimited)
	requireContained(t, contained, 2)
	if target := mappingTarget(t, contained.Mapping, "x"); target != dq.Var("x") {
		t.Fatalf("x maps to %v, want var(x)", target)
	}
	if target := mappingTarget(t, contained.Mapping, "y"); target != dq.Var("x") {
		t.Fatalf("y maps to %v, want var(x) so B's two head positions agree", target)
	}

	reversed := mustCheck(t, problem.Reverse(), dq.Unlimited)
	requireNotContained(t, reversed, -1)
	verifyCounterexample(t, b, a, reversed.Counterexample)
	if head := reversed.Counterexample.Head; len(head) != 2 || head[0] == head[1] {
		t.Fatalf("counterexample head = %v, want two distinct values", head)
	}
}

func TestEmptyBodyAndZeroArityHead(t *testing.T) {
	schema := dq.NewSchema(nil)
	emptyC := dq.NewQuery([]dq.Term{dq.Const("c")})
	emptyD := dq.NewQuery([]dq.Term{dq.Const("d")})
	emptyZeroHead := dq.NewQuery(nil)

	problem := dq.Problem{Schema: schema, A: emptyC, B: emptyC}
	contained := mustCheck(t, problem, 0)
	requireContained(t, contained, 0)
	if len(contained.Mapping) != 0 {
		t.Fatalf("mapping = %v, want empty", contained.Mapping)
	}

	problem = dq.Problem{Schema: schema, A: emptyC, B: emptyD}
	notContained := mustCheck(t, problem, 0)
	requireNotContained(t, notContained, 0)
	verifyCounterexample(t, emptyC, emptyD, notContained.Counterexample)
	if len(notContained.Counterexample.Database.Relations) != 0 {
		t.Fatalf("empty-body counterexample database = %v, want empty", notContained.Counterexample.Database)
	}
	if len(notContained.Counterexample.Head) != 1 ||
		notContained.Counterexample.Head[0] != dq.ConstantValue("c") {
		t.Fatalf("counterexample head = %v, want [c]", notContained.Counterexample.Head)
	}

	problem = dq.Problem{Schema: schema, A: emptyZeroHead, B: emptyZeroHead}
	contained = mustCheck(t, problem, 0)
	requireContained(t, contained, 0)
}

func TestEmptyBodyVersusNonEmptyBody(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	constant := dq.NewQuery([]dq.Term{dq.Const("c")})
	groundAtom := dq.NewQuery(
		[]dq.Term{dq.Const("c")},
		dq.NewAtom("R", dq.Const("c")),
	)

	problem := dq.Problem{Schema: schema, A: constant, B: groundAtom}
	notContained := mustCheck(t, problem, 0)
	requireNotContained(t, notContained, 0)
	verifyCounterexample(t, constant, groundAtom, notContained.Counterexample)

	// Conversely, an always-true empty-body query contains a ground query.
	reversed := mustCheck(t, problem.Reverse(), 0)
	requireContained(t, reversed, 0)
}

func TestZeroArityHeadWithNonEmptyBody(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{},
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)

	result := mustCheck(t, dq.Problem{Schema: schema, A: a, B: b}, dq.Unlimited)
	requireNotContained(t, result, -1)
	verifyCounterexample(t, a, b, result.Counterexample)
	if len(result.Counterexample.Head) != 0 {
		t.Fatalf("zero-arity counterexample head = %v, want empty", result.Counterexample.Head)
	}

	reversed := mustCheck(t, dq.Problem{Schema: schema, A: a, B: b}.Reverse(), dq.Unlimited)
	requireContained(t, reversed, -1)
}

func TestConstantHeadWithNonEmptyBody(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Const("c")},
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Const("c")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)

	result := mustCheck(t, dq.Problem{Schema: schema, A: a, B: b}, dq.Unlimited)
	requireNotContained(t, result, -1)
	verifyCounterexample(t, a, b, result.Counterexample)
	if len(result.Counterexample.Head) != 1 ||
		result.Counterexample.Head[0] != dq.ConstantValue("c") {
		t.Fatalf("constant-head counterexample = %v, want [c]", result.Counterexample.Head)
	}

	reversed := mustCheck(t, dq.Problem{Schema: schema, A: a, B: b}.Reverse(), dq.Unlimited)
	requireContained(t, reversed, -1)
}

func TestFirstSuccessfulMappingOrder(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 2})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("y")},
		dq.NewAtom("R", dq.Var("y"), dq.Var("z")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}

	result := mustCheck(t, problem, dq.Unlimited)
	requireContained(t, result, 3)
	if target := mappingTarget(t, result.Mapping, "y"); target != dq.Var("x") {
		t.Fatalf("y maps to %v, want var(x)", target)
	}
	if target := mappingTarget(t, result.Mapping, "z"); target != dq.Const("a") {
		t.Fatalf("z maps to %v, want constant a (constants precede variables)", target)
	}

	// B variables sort as w < z. w=x is an earlier full-assignment prefix
	// but is impossible; the first success is therefore w=y, z=x.
	multiVarA := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	multiVarB := dq.NewQuery(
		[]dq.Term{dq.Var("z")},
		dq.NewAtom("R", dq.Var("z"), dq.Var("w")),
	)
	result = mustCheck(t, dq.Problem{Schema: schema, A: multiVarA, B: multiVarB}, dq.Unlimited)
	requireContained(t, result, 3)
	if target := mappingTarget(t, result.Mapping, "w"); target != dq.Var("y") {
		t.Fatalf("w maps to %v, want var(y)", target)
	}
	if target := mappingTarget(t, result.Mapping, "z"); target != dq.Var("x") {
		t.Fatalf("z maps to %v, want var(x)", target)
	}
}

func TestDuplicateAtomsAreIdempotent(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}
	for _, direction := range []dq.Problem{problem, problem.Reverse()} {
		result := mustCheck(t, direction, dq.Unlimited)
		requireContained(t, result, 1)
	}
}

func TestSampleDataCannotProveContainment(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)

	// On this caller-chosen sample, A's answers happen to be a subset of B's.
	sample := dq.NewDatabase()
	sample.Add("R", dq.ConstantValue("1"))
	sample.Add("S", dq.ConstantValue("1"))
	aSample, err := dq.Evaluate(a, *sample)
	if err != nil {
		t.Fatal(err)
	}
	bSample, err := dq.Evaluate(b, *sample)
	if err != nil {
		t.Fatal(err)
	}
	for _, tuple := range aSample {
		if !bSample.Contains(tuple) {
			t.Fatalf("sample does not even satisfy the subset relation")
		}
	}

	problem := dq.Problem{Schema: schema, A: a, B: b}
	result := mustCheck(t, problem, dq.Unlimited)
	requireNotContained(t, result, -1)
	verifyCounterexample(t, a, b, result.Counterexample)
}

func TestTypedFreshSymbolsDoNotCollideWithConstants(t *testing.T) {
	if dq.FreshValue(0) == dq.ConstantValue("fresh#0") ||
		dq.FreshValue(0) == dq.ConstantValue("0") ||
		dq.FreshValue(0) == dq.ConstantValue("") {
		t.Fatalf("fresh symbols compare equal to a user constant")
	}

	schema := dq.NewSchema(map[string]int{"R": 2})
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("fresh#0")),
	)

	// B contained in A fails; B's counterexample uses fresh#0 and fresh#1 as
	// symbols. A requires the literal user constant "fresh#0" in position two,
	// which must not match fresh#1.
	result := mustCheck(t, dq.Problem{Schema: schema, A: b, B: a}, dq.Unlimited)
	requireNotContained(t, result, -1)
	verifyCounterexample(t, b, a, result.Counterexample)

	for relation, rows := range result.Counterexample.Database.Relations {
		if !strings.HasPrefix(relation, "R") {
			continue
		}
		for _, row := range rows {
			for _, value := range row {
				if value.IsConstant() {
					if text, _ := value.Text(); text == "fresh#0" {
						t.Fatalf("counterexample contains a user constant that could collide with a fresh symbol")
					}
				}
			}
		}
	}
}

func TestBudgetSegmentationMatchesSingleRun(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 2})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("y")},
		dq.NewAtom("R", dq.Var("y"), dq.Var("z")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}

	single := mustCheck(t, problem, dq.Unlimited)
	requireContained(t, single, 3)

	first := mustCheck(t, problem, 0)
	requireUndecided(t, first, 0)
	if first.TotalSteps != 0 {
		t.Fatalf("TotalSteps = %d, want 0", first.TotalSteps)
	}

	var segmented dq.Result
	for attempt := 0; attempt < 20; attempt++ {
		if attempt == 0 {
			segmented = mustResume(t, problem, first.Cursor, 1)
		} else {
			segmented = mustResume(t, problem, segmented.Cursor, 1)
		}
		if segmented.Status != dq.Undecided {
			break
		}
	}
	requireContained(t, segmented, 1)
	if segmented.TotalSteps != single.TotalSteps {
		t.Fatalf("segmented TotalSteps = %d, single = %d", segmented.TotalSteps, single.TotalSteps)
	}
	if len(segmented.Mapping) != len(single.Mapping) {
		t.Fatalf("segmented mapping = %v, single = %v", segmented.Mapping, single.Mapping)
	}
	for i := range single.Mapping {
		if segmented.Mapping[i] != single.Mapping[i] {
			t.Fatalf("segmented mapping = %v, single = %v", segmented.Mapping, single.Mapping)
		}
	}
}

func TestBudgetNeverReturnsNotContained(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "T": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("T", dq.Var("x")),
	)
	problem := dq.Problem{Schema: schema, A: a, B: b}

	single := mustCheck(t, problem, dq.Unlimited)
	requireNotContained(t, single, 1)

	first := mustCheck(t, problem, 0)
	requireUndecided(t, first, 0)
	resumed := mustResume(t, problem, first.Cursor, 1)
	requireNotContained(t, resumed, 1)
	if resumed.TotalSteps != single.TotalSteps {
		t.Fatalf("TotalSteps = %d, want %d", resumed.TotalSteps, single.TotalSteps)
	}
	verifyCounterexample(t, a, b, resumed.Counterexample)
	if databaseSignature(resumed.Counterexample.Database) != databaseSignature(single.Counterexample.Database) {
		t.Fatalf("segmented and single-run counterexamples differ")
	}
	if !resumed.Counterexample.Head.Equal(single.Counterexample.Head) {
		t.Fatalf("segmented and single-run counterexample heads differ")
	}
}

func TestCursorOwnsSnapshotAndProgressIsACopy(t *testing.T) {
	build := func() dq.Problem {
		schema := dq.NewSchema(map[string]int{"R": 2})
		a := dq.NewQuery(
			[]dq.Term{dq.Var("x")},
			dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
		)
		b := dq.NewQuery(
			[]dq.Term{dq.Var("y")},
			dq.NewAtom("R", dq.Var("y"), dq.Var("z")),
		)
		return dq.Problem{Schema: schema, A: a, B: b}
	}
	mutable := build()
	pristine := build()

	single := mustCheck(t, pristine, dq.Unlimited)
	requireContained(t, single, 3)

	first := mustCheck(t, mutable, 1)
	requireUndecided(t, first, 1)

	// Mutate the original caller-owned query, schema, and a copy returned by
	// Progress. None of these can change the cursor snapshot.
	mutable.A.Head[0] = dq.Const("mutated")
	mutable.A.Body[0].Terms[0] = dq.Const("mutated")
	mutable.B.Body[0].Terms[0] = dq.Const("mutated")
	mutable.Schema.Arities["R"] = 3
	progress := first.Cursor.Progress()
	progress.Variables[0] = "mutated"
	progress.NextVariable = "mutated"

	resumed := mustResume(t, pristine, first.Cursor, dq.Unlimited)
	requireContained(t, resumed, 2)
	if resumed.TotalSteps != single.TotalSteps {
		t.Fatalf("resumed TotalSteps = %d, single = %d", resumed.TotalSteps, single.TotalSteps)
	}
	for i := range single.Mapping {
		if resumed.Mapping[i] != single.Mapping[i] {
			t.Fatalf("resumed mapping = %v, single = %v", resumed.Mapping, single.Mapping)
		}
	}

	if _, err := dq.Resume(pristine, first.Cursor, 1); err == nil {
		t.Fatalf("resuming a decided cursor should fail")
	}
	if _, err := dq.Resume(dq.Problem{Schema: mutable.Schema, A: mutable.A, B: mutable.B}, first.Cursor, 1); err == nil {
		t.Fatalf("resuming with a different input should fail")
	}
}
