package datalog

import (
	"math/rand"
	"reflect"
	"testing"
)

// referenceModel is an independent naive least-fixpoint evaluator,
// computed from the empty interpretation, used to cross-check the DB.
func referenceModel(base []Fact, rules []Rule) map[Fact]bool {
	model := map[Fact]bool{}
	for _, f := range base {
		model[f] = true
	}
	match := func(a Atom, f Fact, s map[string]string) (map[string]string, bool) {
		if a.Pred != f.Pred || a.Arity != f.Arity {
			return nil, false
		}
		out := map[string]string{}
		for k, v := range s {
			out[k] = v
		}
		for i := 0; i < a.Arity; i++ {
			t := a.Args[i]
			if t.IsVar {
				if b, ok := out[t.Val]; ok && b != f.Args[i] {
					return nil, false
				}
				out[t.Val] = f.Args[i]
			} else if t.Val != f.Args[i] {
				return nil, false
			}
		}
		return out, true
	}
	for changed := true; changed; {
		changed = false
		for _, r := range rules {
			substs := []map[string]string{{}}
			for _, b := range r.Body {
				var next []map[string]string
				for _, s := range substs {
					for f := range model {
						if ns, ok := match(b, f, s); ok {
							next = append(next, ns)
						}
					}
				}
				substs = next
			}
			for _, s := range substs {
				var h Fact
				h.Pred, h.Arity = r.Head.Pred, r.Head.Arity
				for i := 0; i < h.Arity; i++ {
					if r.Head.Args[i].IsVar {
						h.Args[i] = s[r.Head.Args[i].Val]
					} else {
						h.Args[i] = r.Head.Args[i].Val
					}
				}
				if !model[h] {
					model[h] = true
					changed = true
				}
			}
		}
	}
	return model
}

func modelSet(db *DB) map[Fact]bool {
	m := map[Fact]bool{}
	for _, f := range db.Facts() {
		m[f] = true
	}
	return m
}

func checkAgainstReference(t *testing.T, db *DB) {
	t.Helper()
	want := referenceModel(db.BaseFacts(), db.Rules())
	got := modelSet(db)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("model mismatch with from-empty least fixpoint\ngot:  %v\nwant: %v", got, want)
	}
}

func TestTransitiveClosureWithDerivations(t *testing.T) {
	db := New()
	if err := db.AddRule(R(A("reach", V("X"), V("Y")), A("edge", V("X"), V("Y")))); err != nil {
		t.Fatal(err)
	}
	if err := db.AddRule(R(A("reach", V("X"), V("Z")), A("edge", V("X"), V("Y")), A("reach", V("Y"), V("Z")))); err != nil {
		t.Fatal(err)
	}
	if err := db.Apply([]Fact{F("edge", "a", "b"), F("edge", "b", "c"), F("edge", "c", "d")}, nil); err != nil {
		t.Fatal(err)
	}
	for _, f := range []Fact{F("reach", "a", "d"), F("reach", "a", "c"), F("reach", "b", "d")} {
		if !db.Holds(f) {
			t.Fatalf("expected %v to hold", f)
		}
	}
	d, ok := db.Explain(F("reach", "a", "d"))
	if !ok {
		t.Fatal("no derivation for reach(a,d)")
	}
	if d.Rule == nil || len(d.Sub) != 2 {
		t.Fatalf("derivation should use the recursive rule with 2 subgoals, got %+v", d)
	}
	if depth := d.Depth(); depth <= 0 || depth > 4 {
		t.Fatalf("derivation must be finite and shallow, depth=%d", depth)
	}
	leaves := d.Leaves()
	for _, l := range leaves {
		if l.Pred != "edge" {
			t.Fatalf("derivation leaf %v is not a base edge fact", l)
		}
	}
	if len(leaves) != 3 {
		t.Fatalf("reach(a,d) should rest on exactly 3 base edges, got %v", leaves)
	}
	checkAgainstReference(t, db)
}

func TestRecursiveDeletionDropsMutuallySupportedFacts(t *testing.T) {
	db := New()
	// a and b support each other; the only outside support is c.
	mustRule(t, db, R(A("a", V("X")), A("b", V("X"))))
	mustRule(t, db, R(A("b", V("X")), A("a", V("X"))))
	mustRule(t, db, R(A("a", V("X")), A("c", V("X"))))
	if err := db.Apply([]Fact{F("c", "1")}, nil); err != nil {
		t.Fatal(err)
	}
	for _, f := range []Fact{F("a", "1"), F("b", "1")} {
		if !db.Holds(f) {
			t.Fatalf("expected %v to hold before deletion", f)
		}
	}
	// Recursively delete the sole support: nothing may survive on the
	// a<->b mutual-support cycle alone.
	if err := db.Apply(nil, []Fact{F("c", "1")}); err != nil {
		t.Fatal(err)
	}
	for _, f := range []Fact{F("a", "1"), F("b", "1")} {
		if db.Holds(f) {
			t.Fatalf("%v retained after its only support was deleted", f)
		}
	}
	if got := db.Facts(); len(got) != 0 {
		t.Fatalf("expected empty model after recursive deletion, got %v", got)
	}
	checkAgainstReference(t, db)
}

func TestBatchAtomicity(t *testing.T) {
	db := New()
	mustRule(t, db, R(A("q", V("X")), A("p", V("X"))))
	if err := db.Apply([]Fact{F("p", "keep")}, nil); err != nil {
		t.Fatal(err)
	}
	bad := Fact{Pred: "wide", Arity: 4}
	bad.Args[0], bad.Args[1], bad.Args[2] = "x", "y", "z"
	err := db.Apply([]Fact{F("p", "new"), bad}, []Fact{F("p", "keep")})
	if err == nil {
		t.Fatal("expected batch with arity-4 fact to be rejected")
	}
	if !db.Holds(F("p", "keep")) {
		t.Fatal("rejected batch must not delete p(keep)")
	}
	if db.Holds(F("p", "new")) {
		t.Fatal("rejected batch must not add p(new)")
	}
	if !db.Holds(F("q", "keep")) {
		t.Fatal("derived q(keep) must survive the rejected batch")
	}
	checkAgainstReference(t, db)
}

func TestValidation(t *testing.T) {
	db := New()
	if err := db.AddRule(R(A("w", V("A"), V("B"), V("C"), V("D")), A("p", V("A")))); err == nil {
		t.Fatal("arity-4 rule head must be rejected")
	}
	if err := db.AddRule(R(A("p", V("X"), V("Y")), A("q", V("X")))); err == nil {
		t.Fatal("unsafe rule (unbound head variable) must be rejected")
	}
	if err := db.AddRule(R(A("p", V("X")))); err == nil {
		t.Fatal("empty-body rule must be rejected")
	}
	if err := db.Apply([]Fact{{Pred: "wide", Arity: 4}}, nil); err == nil {
		t.Fatal("arity-4 fact must be rejected")
	}
	if err := db.Apply([]Fact{F("ok", "1")}, nil); err != nil {
		t.Fatalf("arity-1 fact must be accepted: %v", err)
	}
}

func TestQuery(t *testing.T) {
	db := New()
	mustRule(t, db, R(A("path", V("X"), V("Y")), A("edge", V("X"), V("Y"))))
	if err := db.Apply([]Fact{F("edge", "a", "b"), F("edge", "a", "c"), F("edge", "b", "c")}, nil); err != nil {
		t.Fatal(err)
	}
	got := db.Query(A("path", C("a"), V("To")))
	want := []Fact{F("path", "a", "b"), F("path", "a", "c")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("query got %v want %v", got, want)
	}
}

// TestRandomBatchesMatchReference applies pseudo-random atomic batches
// of additions and deletions over recursive rules and cross-checks the
// store against the from-empty least fixpoint after every batch.
func TestRandomBatchesMatchReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	db := New()
	mustRule(t, db, R(A("t", V("X"), V("Y")), A("e", V("X"), V("Y"))))
	mustRule(t, db, R(A("t", V("X"), V("Z")), A("e", V("X"), V("Y")), A("t", V("Y"), V("Z"))))
	mustRule(t, db, R(A("s", V("X")), A("t", V("X"), V("X"))))
	mustRule(t, db, R(A("u", V("X"), V("Y"), V("Z")), A("t", V("X"), V("Y")), A("t", V("Y"), V("Z"))))
	consts := []string{"a", "b", "c", "d", "e"}
	randFact := func() Fact {
		return F("e", consts[rng.Intn(len(consts))], consts[rng.Intn(len(consts))])
	}
	for i := 0; i < 200; i++ {
		var adds, dels []Fact
		for n := rng.Intn(4); n >= 0; n-- {
			adds = append(adds, randFact())
		}
		for n := rng.Intn(4); n >= 0; n-- {
			dels = append(dels, randFact())
		}
		if err := db.Apply(adds, dels); err != nil {
			t.Fatalf("batch %d: %v", i, err)
		}
		checkAgainstReference(t, db)
		// Every derivation must be finite and grounded in current base facts.
		base := map[Fact]bool{}
		for _, f := range db.BaseFacts() {
			base[f] = true
		}
		for _, f := range db.Facts() {
			d, _ := db.Explain(f)
			for _, l := range d.Leaves() {
				if !base[l] {
					t.Fatalf("batch %d: %v derived from non-base leaf %v", i, f, l)
				}
			}
		}
	}
}

func mustRule(t *testing.T, db *DB, r Rule) {
	t.Helper()
	if err := db.AddRule(r); err != nil {
		t.Fatal(err)
	}
}
