package datalog

import (
	"math/rand"
	"testing"
)

// naiveModel is an independent least-fixpoint evaluator, written directly
// from the semantics: start from the empty IDB and fire rules until
// nothing new appears. The engine's model is cross-checked against it.
func naiveModel(rules []Rule, edb []Fact) map[string]Fact {
	model := map[string]Fact{}
	for _, f := range edb {
		model[f.key()] = f
	}
	for changed := true; changed; {
		changed = false
		for _, r := range rules {
			subs := []subst{{}}
			for _, b := range r.Body {
				var next []subst
				for _, s := range subs {
					for _, f := range model {
						if f.Pred != b.Pred || len(f.Args) != len(b.Args) {
							continue
						}
						if ns, ok := unifyArgs(b.Args, f.Args, s); ok {
							next = append(next, ns)
						}
					}
				}
				subs = next
			}
			for _, s := range subs {
				f := instantiate(r.Head, s)
				if _, ok := model[f.key()]; !ok {
					model[f.key()] = f
					changed = true
				}
			}
		}
	}
	return model
}

func factSet(facts []Fact) map[string]Fact {
	m := map[string]Fact{}
	for _, f := range facts {
		m[f.key()] = f
	}
	return m
}

func checkModelEqual(t *testing.T, e *Engine, rules []Rule) {
	t.Helper()
	want := naiveModel(rules, e.EDB())
	got := factSet(e.Model())
	if len(got) != len(want) {
		t.Fatalf("model size = %d, naive fixpoint = %d\ngot:  %v\nwant: %v", len(got), len(want), e.Model(), want)
	}
	for k := range want {
		if _, ok := got[k]; !ok {
			t.Fatalf("missing fact %s from engine model", k)
		}
	}
}

// checkDerivation verifies a derivation tree is acyclic (hence finite) and
// valid against the engine's rules and EDB.
func checkDerivation(t *testing.T, e *Engine, d *Derivation, active map[*Derivation]bool) {
	t.Helper()
	if active[d] {
		t.Fatalf("cyclic derivation for %s", d.Fact)
	}
	active[d] = true
	defer delete(active, d)

	if d.Rule == -1 {
		if len(d.Children) != 0 {
			t.Fatalf("EDB fact %s has children", d.Fact)
		}
		if _, ok := factSet(e.EDB())[d.Fact.key()]; !ok {
			t.Fatalf("EDB leaf %s not in EDB", d.Fact)
		}
		return
	}
	if d.Rule < 0 || d.Rule >= len(e.rules) {
		t.Fatalf("bad rule index %d", d.Rule)
	}
	r := e.rules[d.Rule]
	if len(r.Body) != len(d.Children) {
		t.Fatalf("derivation of %s: %d children, rule body has %d atoms", d.Fact, len(d.Children), len(r.Body))
	}
	// Unify the rule head with the derived fact, then extend the same
	// substitution by unifying each body atom with its child fact.
	s, ok := unifyArgs(r.Head.Args, d.Fact.Args, subst{})
	if !ok {
		t.Fatalf("head of rule does not unify with derived fact %s", d.Fact)
	}
	for i, b := range r.Body {
		s, ok = unifyArgs(b.Args, d.Children[i].Fact.Args, s)
		if !ok {
			t.Fatalf("derivation of %s: body atom %d inconsistent with child %s", d.Fact, i, d.Children[i].Fact)
		}
		checkDerivation(t, e, d.Children[i], active)
	}
}

func checkAllDerivations(t *testing.T, e *Engine) {
	t.Helper()
	for _, f := range e.Model() {
		d, ok := e.DerivationOf(f)
		if !ok {
			t.Fatalf("no derivation for model fact %s", f)
		}
		checkDerivation(t, e, d, map[*Derivation]bool{})
	}
}

func mustRule(t *testing.T, e *Engine, r Rule) {
	t.Helper()
	if err := e.AddRule(r); err != nil {
		t.Fatalf("AddRule: %v", err)
	}
}

func mustApply(t *testing.T, e *Engine, changes ...Change) {
	t.Helper()
	if err := e.Apply(changes...); err != nil {
		t.Fatalf("Apply: %v", err)
	}
}

func TestTransitiveClosure(t *testing.T) {
	e := New()
	rules := []Rule{
		R(Lit("path", V("x"), V("y")), Lit("edge", V("x"), V("y"))),
		R(Lit("path", V("x"), V("z")), Lit("edge", V("x"), V("y")), Lit("path", V("y"), V("z"))),
	}
	for _, r := range rules {
		mustRule(t, e, r)
	}
	mustApply(t, e,
		Insert(F("edge", "a", "b")),
		Insert(F("edge", "b", "c")),
		Insert(F("edge", "c", "d")),
	)
	for _, f := range []Fact{
		F("path", "a", "b"), F("path", "a", "c"), F("path", "a", "d"),
		F("path", "b", "c"), F("path", "b", "d"), F("path", "c", "d"),
	} {
		if !e.Contains(f) {
			t.Fatalf("expected %s in model", f)
		}
	}
	if e.Contains(F("path", "d", "a")) {
		t.Fatal("unexpected path(d,a)")
	}
	checkModelEqual(t, e, rules)
	checkAllDerivations(t, e)
}

// TestCircularSupportDeleted is the key recursive-deletion case: p and q
// derive each other, and both are ultimately grounded in r. Deleting r
// must remove p and q; a counting-based approach would keep them alive
// through their mutual support.
func TestCircularSupportDeleted(t *testing.T) {
	e := New()
	rules := []Rule{
		R(Lit("p", V("x")), Lit("r", V("x"))),
		R(Lit("p", V("x")), Lit("q", V("x"))),
		R(Lit("q", V("x")), Lit("p", V("x"))),
	}
	for _, r := range rules {
		mustRule(t, e, r)
	}
	mustApply(t, e, Insert(F("r", "1")))
	if !e.Contains(F("p", "1")) || !e.Contains(F("q", "1")) {
		t.Fatal("expected p(1) and q(1) after inserting r(1)")
	}
	checkModelEqual(t, e, rules)
	checkAllDerivations(t, e)

	mustApply(t, e, Delete(F("r", "1")))
	if e.Contains(F("p", "1")) || e.Contains(F("q", "1")) {
		t.Fatalf("circularly supported facts survived deletion: %v", e.Model())
	}
	if len(e.Model()) != 0 {
		t.Fatalf("expected empty model, got %v", e.Model())
	}
	checkModelEqual(t, e, rules)
}

// TestSelfAndMutualCycles combines a self-supporting rule with a longer
// mutual cycle; deleting the base must cascade through all of it.
func TestSelfAndMutualCycles(t *testing.T) {
	e := New()
	rules := []Rule{
		R(Lit("a", V("x")), Lit("base", V("x"))),
		R(Lit("a", V("x")), Lit("a", V("x"))),
		R(Lit("b", V("x")), Lit("a", V("x"))),
		R(Lit("c", V("x")), Lit("b", V("x"))),
		R(Lit("b", V("x")), Lit("c", V("x"))),
	}
	for _, r := range rules {
		mustRule(t, e, r)
	}
	mustApply(t, e, Insert(F("base", "k")))
	for _, p := range []string{"a", "b", "c"} {
		if !e.Contains(F(p, "k")) {
			t.Fatalf("expected %s(k)", p)
		}
	}
	mustApply(t, e, Delete(F("base", "k")))
	if n := len(e.Model()); n != 0 {
		t.Fatalf("expected empty model after cascade delete, got %v", e.Model())
	}
	checkModelEqual(t, e, rules)
}

func TestAtomicBatch(t *testing.T) {
	e := New()
	rules := []Rule{R(Lit("p", V("x")), Lit("q", V("x")))}
	mustRule(t, e, rules[0])
	mustApply(t, e, Insert(F("q", "1")))
	before := e.Model()

	// Batch mixes valid changes with an invalid (arity 4) fact: the whole
	// batch must be rejected and nothing may change.
	err := e.Apply(
		Insert(F("q", "2")),
		Delete(F("q", "1")),
		Insert(F("q", "a", "b", "c", "d")),
	)
	if err == nil {
		t.Fatal("expected error for arity-4 fact")
	}
	after := e.Model()
	if len(after) != len(before) {
		t.Fatalf("batch not atomic: model changed from %v to %v", before, after)
	}
	for i := range before {
		if before[i].key() != after[i].key() {
			t.Fatalf("batch not atomic: model changed from %v to %v", before, after)
		}
	}
	if !e.Contains(F("q", "1")) || e.Contains(F("q", "2")) {
		t.Fatalf("batch not atomic: %v", e.Model())
	}

	// A valid batch applies all-or-nothing in one step.
	mustApply(t, e, Insert(F("q", "2")), Delete(F("q", "1")))
	if e.Contains(F("q", "1")) || !e.Contains(F("p", "2")) {
		t.Fatalf("valid batch not applied: %v", e.Model())
	}
	checkModelEqual(t, e, rules)
}

func TestArityLimit(t *testing.T) {
	e := New()
	if err := e.AddRule(R(Lit("p", V("a"), V("b"), V("c"), V("d")), Lit("q", V("a")))); err == nil {
		t.Fatal("expected arity error for rule head")
	}
	if err := e.AddRule(R(Lit("p", V("a")), Lit("q", V("a"), V("b"), V("c"), V("d")))); err == nil {
		t.Fatal("expected arity error for rule body")
	}
	if err := e.Apply(Insert(F("r", "1", "2", "3", "4"))); err == nil {
		t.Fatal("expected arity error for fact")
	}
	// Arity 3 is fine.
	mustRule(t, e, R(Lit("p", V("a"), V("b"), V("c")), Lit("q", V("a"), V("b"), V("c"))))
	mustApply(t, e, Insert(F("q", "1", "2", "3")))
	if !e.Contains(F("p", "1", "2", "3")) {
		t.Fatal("arity-3 derivation failed")
	}
}

func TestUnsafeRuleRejected(t *testing.T) {
	e := New()
	if err := e.AddRule(R(Lit("p", V("x")), Lit("q", V("y")))); err == nil {
		t.Fatal("expected unsafe-rule error")
	}
	// Empty body with ground head is a safe fact rule.
	mustRule(t, e, R(Lit("s", C("c"))))
	if !e.Contains(F("s", "c")) {
		t.Fatal("fact rule did not fire")
	}
}

func TestDerivationShape(t *testing.T) {
	e := New()
	mustRule(t, e, R(Lit("path", V("x"), V("y")), Lit("edge", V("x"), V("y"))))
	mustRule(t, e, R(Lit("path", V("x"), V("z")), Lit("edge", V("x"), V("y")), Lit("path", V("y"), V("z"))))
	mustApply(t, e, Insert(F("edge", "a", "b")), Insert(F("edge", "b", "c")))

	d, ok := e.DerivationOf(F("path", "a", "c"))
	if !ok {
		t.Fatal("no derivation for path(a,c)")
	}
	if d.Rule != 1 || len(d.Children) != 2 {
		t.Fatalf("unexpected derivation shape: %+v", d)
	}
	if d.Children[0].Fact.key() != "edge(a,b)" || d.Children[0].Rule != -1 {
		t.Fatalf("bad first child: %+v", d.Children[0])
	}
	if d.Children[1].Fact.key() != "path(b,c)" {
		t.Fatalf("bad second child: %+v", d.Children[1])
	}
	checkAllDerivations(t, e)
}

// TestCrossCheckRandom generates random safe rule sets and random fact
// batches (inserts and deletes), and after every batch compares the
// engine's model with the independent naive least fixpoint from empty.
func TestCrossCheckRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	consts := []string{"c0", "c1", "c2", "c3"}
	preds := []string{"p", "q", "r"}

	// freshOK allows introducing a fresh variable (body only); head terms
	// must be constants or variables already bound in the body.
	randTerm := func(bound []string, freshOK bool) Term {
		if len(bound) > 0 && rng.Intn(3) > 0 {
			return V(bound[rng.Intn(len(bound))])
		}
		if !freshOK || rng.Intn(2) == 0 {
			return C(consts[rng.Intn(len(consts))])
		}
		return V("v" + string(rune('0'+rng.Intn(6))))
	}

	for trial := 0; trial < 150; trial++ {
		e := New()
		var rules []Rule
		for i := 0; i < 1+rng.Intn(4); i++ {
			var body []Atom
			var bound []string
			for j := 0; j < 1+rng.Intn(2); j++ {
				arity := 1 + rng.Intn(MaxArity)
				a := Atom{Pred: preds[rng.Intn(len(preds))]}
				for k := 0; k < arity; k++ {
					tm := randTerm(bound, true)
					a.Args = append(a.Args, tm)
					if tm.Variable {
						bound = append(bound, tm.Name)
					}
				}
				body = append(body, a)
			}
			head := Atom{Pred: preds[rng.Intn(len(preds))]}
			for k := 0; k < 1+rng.Intn(MaxArity); k++ {
				head.Args = append(head.Args, randTerm(bound, false))
			}
			r := Rule{Head: head, Body: body}
			if err := e.AddRule(r); err != nil {
				t.Fatalf("trial %d: generated rule rejected: %v", trial, err)
			}
			rules = append(rules, r)
		}
		for batch := 0; batch < 6; batch++ {
			var changes []Change
			for i := 0; i < 1+rng.Intn(4); i++ {
				arity := 1 + rng.Intn(MaxArity)
				f := Fact{Pred: preds[rng.Intn(len(preds))]}
				for k := 0; k < arity; k++ {
					f.Args = append(f.Args, consts[rng.Intn(len(consts))])
				}
				if rng.Intn(3) == 0 {
					changes = append(changes, Delete(f))
				} else {
					changes = append(changes, Insert(f))
				}
			}
			if err := e.Apply(changes...); err != nil {
				t.Fatalf("trial %d batch %d: %v", trial, batch, err)
			}
			checkModelEqual(t, e, rules)
		}
		checkAllDerivations(t, e)
	}
}
