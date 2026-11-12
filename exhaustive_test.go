package dataeng_test

import (
	"sort"
	"testing"

	dq "example.org/dataeng/q0294"
)

type fact struct {
	relation string
	tuple    dq.Tuple
}

func queryConstants(q dq.Query) []string {
	seen := make(map[string]struct{})
	add := func(term dq.Term) {
		if term.Kind == dq.ConstantTerm {
			seen[term.Name] = struct{}{}
		}
	}
	for _, term := range q.Head {
		add(term)
	}
	for _, atom := range q.Body {
		for _, term := range atom.Terms {
			add(term)
		}
	}
	out := make([]string, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func domainValues(base []string, queries ...dq.Query) []dq.Value {
	seen := make(map[string]struct{})
	for _, value := range base {
		seen[value] = struct{}{}
	}
	for _, q := range queries {
		for _, value := range queryConstants(q) {
			seen[value] = struct{}{}
		}
	}
	values := make([]string, 0, len(seen))
	for value := range seen {
		values = append(values, value)
	}
	sort.Strings(values)
	domain := make([]dq.Value, len(values))
	for i, value := range values {
		domain[i] = dq.ConstantValue(value)
	}
	return domain
}

func relationTuples(domain []dq.Value, arity int) []dq.Tuple {
	if arity == 0 {
		return []dq.Tuple{{}}
	}
	out := make([]dq.Tuple, 0)
	var build func(prefix dq.Tuple)
	build = func(prefix dq.Tuple) {
		if len(prefix) == arity {
			out = append(out, prefix.Clone())
			return
		}
		for _, value := range domain {
			build(append(prefix, value))
		}
	}
	build(nil)
	return out
}

func allFacts(schema dq.Schema, domain []dq.Value) []fact {
	relations := make([]string, 0, len(schema.Arities))
	for relation := range schema.Arities {
		relations = append(relations, relation)
	}
	sort.Strings(relations)

	var facts []fact
	for _, relation := range relations {
		for _, tuple := range relationTuples(domain, schema.Arities[relation]) {
			facts = append(facts, fact{relation: relation, tuple: tuple})
		}
	}
	return facts
}

func databaseFromMask(facts []fact, mask uint64) dq.Database {
	db := dq.Database{Relations: make(map[string][]dq.Tuple)}
	for i, f := range facts {
		if mask&(uint64(1)<<uint(i)) != 0 {
			db.Relations[f.relation] = append(db.Relations[f.relation], f.tuple)
		}
	}
	return db
}

// exhaustiveContained is independent of the containment search: it enumerates
// every database over the finite domain and compares the interpreter's full
// answer sets. For the small test queries the domain has enough values to
// represent any needed fresh-symbol counterexample up to renaming.
func exhaustiveContained(t *testing.T, schema dq.Schema, a, b dq.Query, domain []dq.Value) bool {
	t.Helper()
	facts := allFacts(schema, domain)
	if len(facts) > 20 {
		t.Fatalf("exhaustive test would enumerate %d facts (2^%d databases)", len(facts), len(facts))
	}
	count := uint64(1) << uint(len(facts))
	for mask := uint64(0); mask < count; mask++ {
		db := databaseFromMask(facts, mask)
		aAnswers, err := dq.Evaluate(a, db)
		if err != nil {
			t.Fatalf("Evaluate(A), mask %d: %v", mask, err)
		}
		bAnswers, err := dq.Evaluate(b, db)
		if err != nil {
			t.Fatalf("Evaluate(B), mask %d: %v", mask, err)
		}
		for _, tuple := range aAnswers {
			if !bAnswers.Contains(tuple) {
				return false
			}
		}
	}
	return true
}

func TestContainmentAgainstExhaustiveSmallDatabases(t *testing.T) {
	unaryRS := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	binaryR := dq.NewSchema(map[string]int{"R": 2})
	unaryR := dq.NewSchema(map[string]int{"R": 1})
	emptySchema := dq.NewSchema(nil)

	cases := []struct {
		name   string
		schema dq.Schema
		a      dq.Query
		b      dq.Query
		domain []string
	}{
		{
			name:   "projection",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "projection-reverse",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "self-join",
			schema: binaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "self-join-reverse",
			schema: binaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "constant-fixed",
			schema: binaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
			),
			domain: []string{"a", "0", "1"},
		},
		{
			name:   "constant-fixed-reverse",
			schema: binaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x"), dq.Const("a")),
			),
			domain: []string{"a", "0", "1"},
		},
		{
			name:   "repeated-head",
			schema: unaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x"), dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x"), dq.Var("y")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("R", dq.Var("y")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "repeated-head-reverse",
			schema: unaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x"), dq.Var("y")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("R", dq.Var("y")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x"), dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "empty-body-equal",
			schema: emptySchema,
			a:      dq.NewQuery([]dq.Term{dq.Const("c")}),
			b:      dq.NewQuery([]dq.Term{dq.Const("c")}),
		},
		{
			name:   "empty-body-head-mismatch",
			schema: emptySchema,
			a:      dq.NewQuery([]dq.Term{dq.Const("c")}),
			b:      dq.NewQuery([]dq.Term{dq.Const("d")}),
		},
		{
			name:   "empty-versus-ground",
			schema: unaryR,
			a:      dq.NewQuery([]dq.Term{dq.Const("c")}),
			b: dq.NewQuery(
				[]dq.Term{dq.Const("c")},
				dq.NewAtom("R", dq.Const("c")),
			),
			domain: []string{"c", "0"},
		},
		{
			name:   "ground-versus-empty",
			schema: unaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Const("c")},
				dq.NewAtom("R", dq.Const("c")),
			),
			b:      dq.NewQuery([]dq.Term{dq.Const("c")}),
			domain: []string{"c", "0"},
		},
		{
			name:   "duplicate-atom",
			schema: unaryR,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("R", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
			),
			domain: []string{"0", "1"},
		},
		{
			name:   "zero-arity-head",
			schema: emptySchema,
			a:      dq.NewQuery(nil),
			b:      dq.NewQuery(nil),
		},
		{
			name:   "sample-only-not-enough",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Var("x")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "zero-arity-head-with-body",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{},
				dq.NewAtom("R", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "zero-arity-head-with-body-reverse",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{},
				dq.NewAtom("R", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "constant-head-with-body",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{dq.Const("c")},
				dq.NewAtom("R", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Const("c")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
		{
			name:   "constant-head-with-body-reverse",
			schema: unaryRS,
			a: dq.NewQuery(
				[]dq.Term{dq.Const("c")},
				dq.NewAtom("R", dq.Var("x")),
				dq.NewAtom("S", dq.Var("x")),
			),
			b: dq.NewQuery(
				[]dq.Term{dq.Const("c")},
				dq.NewAtom("R", dq.Var("x")),
			),
			domain: []string{"0", "1", "2"},
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			domain := domainValues(test.domain, test.a, test.b)
			semantic := exhaustiveContained(t, test.schema, test.a, test.b, domain)
			result := mustCheck(t, dq.Problem{Schema: test.schema, A: test.a, B: test.b}, dq.Unlimited)
			if semantic {
				requireContained(t, result, -1)
			} else {
				requireNotContained(t, result, -1)
				verifyCounterexample(t, test.a, test.b, result.Counterexample)
			}
			if got := result.Status == dq.Contained; got != semantic {
				t.Fatalf("search says contained=%v, exhaustive semantics says %v", got, semantic)
			}
		})
	}
}

func TestExhaustiveEnumerationHasEnoughFreshValues(t *testing.T) {
	// A non-containment witness can require as many distinct fresh values as
	// the left query has variables. The exhaustive cases use at least three
	// domain values, and this guard documents the assumption.
	schema := dq.NewSchema(map[string]int{"R": 2})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("y")),
		dq.NewAtom("R", dq.Var("y"), dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x"), dq.Var("x")),
	)
	domain := domainValues([]string{"0", "1", "2"}, a, b)
	if got := exhaustiveContained(t, schema, a, b, domain); got {
		t.Fatalf("expected exhaustive enumeration to find a counterexample")
	}
	result := mustCheck(t, dq.Problem{Schema: schema, A: a, B: b}, dq.Unlimited)
	requireNotContained(t, result, -1)
	verifyCounterexample(t, a, b, result.Counterexample)
	if result.Counterexample == nil {
		t.Fatalf("missing counterexample")
	}
}
