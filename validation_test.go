package dataeng_test

import (
	"testing"

	dq "example.org/dataeng/q0294"
)

func TestValidationRejectsNegativeBudget(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	q := dq.NewQuery([]dq.Term{dq.Var("x")}, dq.NewAtom("R", dq.Var("x")))
	problem := dq.Problem{Schema: schema, A: q, B: q}
	if _, err := dq.Check(problem, -1); err == nil {
		t.Fatalf("Check accepted a negative budget")
	}
	if _, err := dq.Resume(problem, nil, -1); err == nil {
		t.Fatalf("Resume accepted a negative budget")
	}
}

func TestValidationVariableAndAtomLimits(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	head := []dq.Term{dq.Var("v0")}
	body := make([]dq.Atom, 0, 13)
	for i := 0; i < 13; i++ {
		body = append(body, dq.NewAtom("R", dq.Var("v"+string(rune('0'+i)))))
	}
	tooManyVars := dq.Query{Head: head, Body: body}
	if _, err := dq.Check(dq.Problem{Schema: schema, A: tooManyVars, B: tooManyVars}, 10); err == nil {
		t.Fatalf("expected variable-count validation error")
	}

	tooManyAtoms := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		func() []dq.Atom {
			out := make([]dq.Atom, 21)
			for i := range out {
				out[i] = dq.NewAtom("R", dq.Var("x"))
			}
			return out
		}()...,
	)
	if _, err := dq.Check(dq.Problem{Schema: schema, A: tooManyAtoms, B: tooManyAtoms}, 10); err == nil {
		t.Fatalf("expected atom-count validation error")
	}
}

func TestValidationHeadBodyAndEmptyBodyRules(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})

	headVarOutsideBody := dq.Query{
		Head: []dq.Term{dq.Var("x"), dq.Var("y")},
		Body: []dq.Atom{dq.NewAtom("R", dq.Var("x"))},
	}
	if _, err := dq.Check(dq.Problem{Schema: schema, A: headVarOutsideBody, B: headVarOutsideBody}, 1); err == nil {
		t.Fatalf("expected head variable outside body error")
	}

	emptyBodyVarHead := dq.Query{Head: []dq.Term{dq.Var("x")}}
	if _, err := dq.Check(dq.Problem{Schema: schema, A: emptyBodyVarHead, B: emptyBodyVarHead}, 1); err == nil {
		t.Fatalf("expected empty-body variable-head error")
	}

	headLengthMismatch := dq.Problem{
		Schema: schema,
		A:      dq.NewQuery([]dq.Term{dq.Var("x")}, dq.NewAtom("R", dq.Var("x"))),
		B:      dq.NewQuery([]dq.Term{dq.Var("x"), dq.Var("x")}, dq.NewAtom("R", dq.Var("x"))),
	}
	if _, err := dq.Check(headLengthMismatch, 1); err == nil {
		t.Fatalf("expected head-length mismatch error")
	}
}

func TestValidationSchemaAndArityRules(t *testing.T) {
	badSchema := dq.NewSchema(map[string]int{"R": 0})
	q := dq.NewQuery([]dq.Term{dq.Var("x")}, dq.NewAtom("R", dq.Var("x")))
	if _, err := dq.Check(dq.Problem{Schema: badSchema, A: q, B: q}, 1); err == nil {
		t.Fatalf("expected non-positive schema arity error")
	}

	schema := dq.NewSchema(map[string]int{"R": 2})
	atomArityMismatch := dq.NewQuery([]dq.Term{dq.Var("x")}, dq.NewAtom("R", dq.Var("x")))
	if _, err := dq.Check(dq.Problem{Schema: schema, A: atomArityMismatch, B: atomArityMismatch}, 1); err == nil {
		t.Fatalf("expected atom arity mismatch error")
	}

	missingRelation := dq.NewQuery([]dq.Term{dq.Var("x")}, dq.NewAtom("T", dq.Var("x")))
	if _, err := dq.Check(dq.Problem{Schema: schema, A: missingRelation, B: missingRelation}, 1); err == nil {
		t.Fatalf("expected missing relation error")
	}
}

func TestValidationRejectsInvalidTermKind(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	bad := dq.Query{
		Head: []dq.Term{dq.Var("x")},
		Body: []dq.Atom{{
			Relation: "R",
			Terms:    []dq.Term{{Kind: dq.TermKind(99), Name: "x"}},
		}},
	}
	if _, err := dq.Check(dq.Problem{Schema: schema, A: bad, B: bad}, 1); err == nil {
		t.Fatalf("expected invalid term kind error")
	}
}

func TestResumeRejectsNilWrongInputAndDecidedCursor(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	q := dq.NewQuery([]dq.Term{dq.Var("x")}, dq.NewAtom("R", dq.Var("x")))
	problem := dq.Problem{Schema: schema, A: q, B: q}

	if _, err := dq.Resume(problem, nil, 1); err == nil {
		t.Fatalf("expected nil cursor error")
	}

	result := mustCheck(t, problem, 0)
	requireUndecided(t, result, 0)

	other := dq.Problem{
		Schema: schema,
		A:      dq.NewQuery([]dq.Term{dq.Const("c")}, dq.NewAtom("R", dq.Const("c"))),
		B:      q,
	}
	if _, err := dq.Resume(other, result.Cursor, 1); err == nil {
		t.Fatalf("expected input mismatch error")
	}

	continued := mustResume(t, problem, result.Cursor, dq.Unlimited)
	requireContained(t, continued, 1)
	if _, err := dq.Resume(problem, result.Cursor, 1); err == nil {
		t.Fatalf("expected decided cursor error")
	}
}
