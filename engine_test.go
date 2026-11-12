package dataeng_test

import (
	"testing"

	dq "example.org/dataeng/q0294"
)

func TestEvaluateSetSemanticsAndJoins(t *testing.T) {
	q := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
		dq.NewAtom("S", dq.Var("y")),
	)
	db := dq.NewDatabase()
	db.Add("R", dq.ConstantValue("1"), dq.ConstantValue("2"))
	db.Add("R", dq.ConstantValue("1"), dq.ConstantValue("2")) // duplicate set member
	db.Add("R", dq.ConstantValue("2"), dq.ConstantValue("3"))
	db.Add("S", dq.ConstantValue("2"))
	db.Add("S", dq.ConstantValue("2"))
	db.Add("S", dq.ConstantValue("4"))

	answers, err := dq.Evaluate(q, *db)
	if err != nil {
		t.Fatal(err)
	}
	want := dq.Tuples{{dq.ConstantValue("1")}}
	if len(answers) != len(want) || !answers.Contains(want[0]) {
		t.Fatalf("answers = %v, want %v", answers, want)
	}

	// S(3) is absent, so the R(2,3) row does not survive the join.
	q2 := dq.NewQuery(
		[]dq.Term{dq.Var("x"), dq.Var("y")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
		dq.NewAtom("S", dq.Var("y")),
	)
	answers, err = dq.Evaluate(q2, *db)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 1 ||
		!answers.Contains(dq.Tuple{dq.ConstantValue("1"), dq.ConstantValue("2")}) {
		t.Fatalf("answers = %v, want [(1,2)]", answers)
	}
	if answers.Contains(dq.Tuple{dq.ConstantValue("2"), dq.ConstantValue("3")}) {
		t.Fatalf("join produced a tuple through missing S(3)")
	}
}

func TestEvaluateSelfJoinConstantAndRepeatedHead(t *testing.T) {
	// R(x,x) keeps the diagonal only.
	diag := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("x")),
	)
	db := dq.NewDatabase()
	db.Add("R", dq.ConstantValue("1"), dq.ConstantValue("1"))
	db.Add("R", dq.ConstantValue("1"), dq.ConstantValue("2"))
	db.Add("R", dq.ConstantValue("2"), dq.ConstantValue("2"))
	answers, err := dq.Evaluate(diag, *db)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 2 ||
		!answers.Contains(dq.Tuple{dq.ConstantValue("1")}) ||
		!answers.Contains(dq.Tuple{dq.ConstantValue("2")}) {
		t.Fatalf("diagonal answers = %v", answers)
	}

	constant := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
	)
	cdb := dq.NewDatabase()
	cdb.Add("R", dq.ConstantValue("0"), dq.ConstantValue("a"))
	cdb.Add("R", dq.ConstantValue("1"), dq.ConstantValue("A"))
	answers, err = dq.Evaluate(constant, *cdb)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 1 || !answers.Contains(dq.Tuple{dq.ConstantValue("0")}) {
		t.Fatalf("constant answers = %v, want [(0)]", answers)
	}

	repeatedHead := dq.NewQuery(
		[]dq.Term{dq.Var("x"), dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	answers, err = dq.Evaluate(repeatedHead, *db)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 2 ||
		!answers.Contains(dq.Tuple{dq.ConstantValue("1"), dq.ConstantValue("1")}) ||
		!answers.Contains(dq.Tuple{dq.ConstantValue("2"), dq.ConstantValue("2")}) {
		t.Fatalf("repeated-head answers = %v", answers)
	}
}

func TestEvaluateEmptyBodyZeroArityAndMissingRelations(t *testing.T) {
	constant := dq.NewQuery([]dq.Term{dq.Const("c")})
	empty := dq.NewDatabase()
	answers, err := dq.Evaluate(constant, *empty)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 1 || !answers.Contains(dq.Tuple{dq.ConstantValue("c")}) {
		t.Fatalf("constant empty-body answers = %v", answers)
	}

	zeroHead := dq.NewQuery(nil)
	answers, err = dq.Evaluate(zeroHead, *empty)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 1 || !answers.Contains(dq.Tuple{}) {
		t.Fatalf("zero-arity answers = %v, want one empty tuple", answers)
	}

	nonEmpty := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	answers, err = dq.Evaluate(nonEmpty, *empty)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 0 {
		t.Fatalf("missing relation answers = %v, want empty", answers)
	}
}

func TestEvaluateDistinguishesFreshSymbolsFromConstants(t *testing.T) {
	q := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	db := dq.NewDatabase()
	db.Add("R", dq.ConstantValue("fresh#0"))
	db.Add("R", dq.FreshValue(0))
	answers, err := dq.Evaluate(q, *db)
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 2 {
		t.Fatalf("answers = %v, want one constant and one fresh tuple", answers)
	}
}

func TestContainsTupleAndHeadConstraints(t *testing.T) {
	q := dq.NewQuery(
		[]dq.Term{dq.Var("x"), dq.Var("y")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	db := dq.NewDatabase()
	db.Add("R", dq.ConstantValue("1"), dq.ConstantValue("2"))

	contains, err := dq.ContainsTuple(q, *db, dq.Tuple{dq.ConstantValue("1"), dq.ConstantValue("2")})
	if err != nil {
		t.Fatal(err)
	}
	if !contains {
		t.Fatalf("(1,2) should be contained")
	}
	contains, err = dq.ContainsTuple(q, *db, dq.Tuple{dq.ConstantValue("2"), dq.ConstantValue("1")})
	if err != nil {
		t.Fatal(err)
	}
	if contains {
		t.Fatalf("(2,1) should not be contained")
	}
	contains, err = dq.ContainsTuple(q, *db, dq.Tuple{dq.ConstantValue("1")})
	if err != nil {
		t.Fatal(err)
	}
	if contains {
		t.Fatalf("tuple of the wrong arity must not be contained")
	}

	repeated := dq.NewQuery(
		[]dq.Term{dq.Var("x"), dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
	)
	contains, err = dq.ContainsTuple(repeated, *db, dq.Tuple{dq.ConstantValue("1"), dq.ConstantValue("2")})
	if err != nil {
		t.Fatal(err)
	}
	if contains {
		t.Fatalf("repeated head positions cannot be constrained to different values")
	}

	empty := dq.NewQuery(nil)
	contains, err = dq.ContainsTuple(empty, *db, dq.Tuple{})
	if err != nil {
		t.Fatal(err)
	}
	if !contains {
		t.Fatalf("empty body/head should contain the empty tuple")
	}
}

func TestEvaluateRejectsArityErrors(t *testing.T) {
	q := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	db := dq.NewDatabase()
	db.Add("R", dq.ConstantValue("1"), dq.ConstantValue("2"))
	if _, err := dq.Evaluate(q, *db); err == nil {
		t.Fatalf("expected database arity error")
	}

	badQuery := dq.Query{
		Head: []dq.Term{dq.Var("x")},
		Body: []dq.Atom{
			dq.NewAtom("R", dq.Var("x")),
			dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
		},
	}
	if _, err := dq.Evaluate(badQuery, *dq.NewDatabase()); err == nil {
		t.Fatalf("expected inconsistent query relation arity error")
	}
}
