package logrule

import (
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func always(Record) bool { return true }

func TestGenerationEffectiveBySeq(t *testing.T) {
	e := NewEngine(4)
	e.ReplaceRules(10, []Rule{{Name: "v1", Match: always}})
	e.ReplaceRules(100, []Rule{{Name: "v2", Match: always}})

	n := e.Process(Record{Seq: 5, Kind: "log", Msg: "before any generation"})
	if n.Gen != -1 || len(n.Matched) != 0 {
		t.Fatalf("seq 5: got gen=%d matched=%v, want gen=-1 matched=[]", n.Gen, n.Matched)
	}
	n = e.Process(Record{Seq: 99, Kind: "log", Msg: "old generation"})
	if n.Gen != 0 || !reflect.DeepEqual(n.Matched, []string{"v1"}) {
		t.Fatalf("seq 99: got gen=%d matched=%v, want gen=0 matched=[v1]", n.Gen, n.Matched)
	}
	n = e.Process(Record{Seq: 100, Kind: "log", Msg: "boundary"})
	if n.Gen != 1 || !reflect.DeepEqual(n.Matched, []string{"v2"}) {
		t.Fatalf("seq 100: got gen=%d matched=%v, want gen=1 matched=[v2]", n.Gen, n.Matched)
	}
	n = e.Process(Record{Seq: 150, Kind: "log", Msg: "after boundary"})
	if n.Gen != 1 || !reflect.DeepEqual(n.Matched, []string{"v2"}) {
		t.Fatalf("seq 150: got gen=%d matched=%v, want gen=1 matched=[v2]", n.Gen, n.Matched)
	}
}

func TestSameRecordSingleGeneration(t *testing.T) {
	e := NewEngine(2)
	e.ReplaceRules(0, []Rule{{Name: "a", Match: always}, {Name: "b", Match: always}})
	e.ReplaceRules(10, []Rule{{Name: "c", Match: always}, {Name: "d", Match: always}})

	n := e.Process(Record{Seq: 10, Kind: "log", Msg: "x"})
	if n.Gen != 1 || !reflect.DeepEqual(n.Matched, []string{"c", "d"}) {
		t.Fatalf("got gen=%d matched=%v, want gen=1 matched=[c d]", n.Gen, n.Matched)
	}
}

func TestReplaceRulesInPlace(t *testing.T) {
	e := NewEngine(1)
	e.ReplaceRules(0, []Rule{{Name: "old", Match: always}})
	e.ReplaceRules(0, []Rule{{Name: "new", Match: always}})

	n := e.Process(Record{Seq: 0, Kind: "log", Msg: "x"})
	if n.Gen != 0 || !reflect.DeepEqual(n.Matched, []string{"new"}) {
		t.Fatalf("got gen=%d matched=%v, want gen=0 matched=[new]", n.Gen, n.Matched)
	}
}

func TestDerivedDiagnosticsMatchButNeverRematchAncestor(t *testing.T) {
	e := NewEngine(8)
	e.ReplaceRules(0, []Rule{
		{
			Name:  "self",
			Match: func(r Record) bool { return r.Kind == "log" },
			Derive: func(rec Record) []Record {
				// Derives the original record itself plus a fresh diagnostic.
				return []Record{rec, {Seq: rec.Seq, Kind: "diag", Msg: rec.Msg + "?"}}
			},
		},
		{
			Name:  "diag-rule",
			Match: func(r Record) bool { return r.Kind == "diag" },
		},
	})

	root := e.Process(Record{Seq: 1, Kind: "log", Msg: "boom"})
	if !reflect.DeepEqual(root.Matched, []string{"self"}) {
		t.Fatalf("root matched=%v, want [self]", root.Matched)
	}
	if len(root.Children) != 2 {
		t.Fatalf("root has %d children, want 2", len(root.Children))
	}
	clone := root.Children[0]
	if clone.Note != NoteRematch || len(clone.Matched) != 0 || len(clone.Children) != 0 {
		t.Fatalf("clone: note=%q matched=%v children=%d, want note=%q matched=[] children=0",
			clone.Note, clone.Matched, len(clone.Children), NoteRematch)
	}
	diag := root.Children[1]
	if diag.Note != "" || !reflect.DeepEqual(diag.Matched, []string{"diag-rule"}) {
		t.Fatalf("diag: note=%q matched=%v, want note=\"\" matched=[diag-rule]", diag.Note, diag.Matched)
	}
}

func TestDepthBudget(t *testing.T) {
	chain := Rule{
		Name:  "chain",
		Match: always,
		Derive: func(rec Record) []Record {
			return []Record{{Seq: rec.Seq, Kind: "diag", Msg: rec.Msg + "+"}}
		},
	}

	e := NewEngine(2)
	e.ReplaceRules(0, []Rule{chain})
	root := e.Process(Record{Seq: 1, Kind: "log", Msg: "x"})

	d1 := root.Children[0]
	d2 := d1.Children[0]
	if root.Depth != 0 || d1.Depth != 1 || d2.Depth != 2 {
		t.Fatalf("depths: %d,%d,%d, want 0,1,2", root.Depth, d1.Depth, d2.Depth)
	}
	if root.Note != "" || d1.Note != "" {
		t.Fatalf("notes: root=%q d1=%q, want both empty", root.Note, d1.Note)
	}
	if d2.Note != NoteDepthBudget || len(d2.Children) != 0 {
		t.Fatalf("d2: note=%q children=%d, want note=%q children=0",
			d2.Note, len(d2.Children), NoteDepthBudget)
	}
	// The budget-exhausted node is still matched, only derivation is dropped.
	if !reflect.DeepEqual(d2.Matched, []string{"chain"}) {
		t.Fatalf("d2 matched=%v, want [chain]", d2.Matched)
	}

	zero := NewEngine(0)
	zero.ReplaceRules(0, []Rule{chain})
	n := zero.Process(Record{Seq: 1, Kind: "log", Msg: "x"})
	if n.Note != NoteDepthBudget || len(n.Children) != 0 {
		t.Fatalf("budget 0: note=%q children=%d, want note=%q children=0",
			n.Note, len(n.Children), NoteDepthBudget)
	}
}

func TestProvenanceTreeString(t *testing.T) {
	e := NewEngine(1)
	e.ReplaceRules(0, []Rule{{
		Name:  "r",
		Match: always,
		Derive: func(rec Record) []Record {
			return []Record{{Seq: rec.Seq, Kind: "diag", Msg: "d"}}
		},
	}})
	got := e.Process(Record{Seq: 7, Kind: "log", Msg: "m"}).String()
	want := "" +
		"depth=0 gen=0 seq=7 kind=\"log\" msg=\"m\" matched=[r]\n" +
		"  depth=1 gen=0 seq=7 kind=\"diag\" msg=\"d\" matched=[r] note=\"depth budget exhausted\"\n"
	if got != want {
		t.Fatalf("tree:\n%s\nwant:\n%s", got, want)
	}
}

// TestProcessMatchesReferenceInterpreter cross-checks the iterative engine
// against the reference recursive interpreter over randomized rule
// generations, replacements, and records.
func TestProcessMatchesReferenceInterpreter(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for trial := 0; trial < 5000; trial++ {
		e := NewEngine(rng.Intn(4))
		nGens := 1 + rng.Intn(3)
		seq := uint64(rng.Intn(4))
		for g := 0; g < nGens; g++ {
			e.ReplaceRules(seq, randomRules(rng))
			seq += uint64(rng.Intn(5))
		}
		rec := randomRecord(rng, 20)
		got := e.Process(rec)
		want := e.Interpret(rec)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("trial %d: mismatch for record %+v\ngot:\n%s\nwant:\n%s",
				trial, rec, got, want)
		}
	}
}

func randomRecord(rng *rand.Rand, seqBound uint64) Record {
	kinds := []string{"log", "diag", "metric"}
	return Record{
		Seq:  uint64(rng.Intn(int(seqBound))),
		Kind: kinds[rng.Intn(len(kinds))],
		Msg:  fmt.Sprintf("m%d", rng.Intn(4)),
	}
}

func randomRules(rng *rand.Rand) []Rule {
	rules := make([]Rule, rng.Intn(4))
	for i := range rules {
		rule := Rule{Name: fmt.Sprintf("rule%d", i)}
		switch rng.Intn(4) {
		case 0:
			rule.Match = always
		case 1:
			rule.Match = func(r Record) bool { return r.Seq%2 == 0 }
		case 2:
			rule.Match = func(r Record) bool { return r.Kind == "diag" }
		case 3:
			rule.Match = func(r Record) bool { return strings.Contains(r.Msg, "1") }
		}
		switch rng.Intn(4) {
		case 0: // no derivation
		case 1: // derive a fresh diagnostic
			delta := uint64(rng.Intn(3))
			rule.Derive = func(rec Record) []Record {
				return []Record{{Seq: rec.Seq + delta, Kind: "diag", Msg: rec.Msg + "d"}}
			}
		case 2: // derive two records
			rule.Derive = func(rec Record) []Record {
				return []Record{
					{Seq: rec.Seq, Kind: "diag", Msg: rec.Msg + "x"},
					{Seq: rec.Seq + 1, Kind: "log", Msg: rec.Msg + "y"},
				}
			}
		case 3: // derive the record itself (must be suppressed as a re-match)
			rule.Derive = func(rec Record) []Record { return []Record{rec} }
		}
		rules[i] = rule
	}
	return rules
}
