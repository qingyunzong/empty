package logrules

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
)

// canonical renders a provenance forest in an id-independent form so the
// breadth-first engine and the depth-first reference interpreter can be
// compared structurally.
func canonical(recs []Record) string {
	children := map[int64][]Record{}
	var root Record
	for _, r := range recs {
		if r.ParentID == -1 {
			root = r
			continue
		}
		children[r.ParentID] = append(children[r.ParentID], r)
	}
	var sb strings.Builder
	var walk func(r Record, indent string)
	walk = func(r Record, indent string) {
		fmt.Fprintf(&sb, "%s(seq=%d gen=%d depth=%d rule=%s msg=%q trunc=%v)\n",
			indent, r.Seq, r.Gen, r.Depth, r.RuleID, r.Message, r.Truncated)
		kids := append([]Record(nil), children[r.ID]...)
		sort.Slice(kids, func(i, j int) bool {
			if kids[i].RuleID != kids[j].RuleID {
				return kids[i].RuleID < kids[j].RuleID
			}
			return kids[i].Message < kids[j].Message
		})
		for _, k := range kids {
			walk(k, indent+"  ")
		}
	}
	walk(root, "")
	return sb.String()
}

func matchAll(msg string) Rule {
	return Rule{
		ID:    "echo",
		Match: func(Record) bool { return true },
		Derive: func(r Record) []string {
			return []string{msg}
		},
	}
}

func TestSeqDeterminesGeneration(t *testing.T) {
	gen0 := []Rule{{
		ID:     "old",
		Match:  func(Record) bool { return true },
		Derive: func(Record) []string { return []string{"from-old"} },
	}}
	gen1 := []Rule{{
		ID:     "new",
		Match:  func(Record) bool { return true },
		Derive: func(Record) []string { return []string{"from-new"} },
	}}

	e := NewEngine(gen0, 1)
	rec1 := e.Log("first")
	e.SetRules(gen1)
	rec2 := e.Log("second")

	if rec1[0].Seq != 1 || rec2[0].Seq != 2 {
		t.Fatalf("sequence numbers: got %d and %d, want 1 and 2", rec1[0].Seq, rec2[0].Seq)
	}
	for _, r := range rec1 {
		if r.Gen != 0 {
			t.Fatalf("record seq=1 used gen=%d, want 0", r.Gen)
		}
	}
	for _, r := range rec2 {
		if r.Gen != 1 {
			t.Fatalf("record seq=2 used gen=%d, want 1", r.Gen)
		}
	}
	if got := rec1[len(rec1)-1].Message; got != "from-old" {
		t.Fatalf("seq=1 derived %q, want %q", got, "from-old")
	}
	if got := rec2[len(rec2)-1].Message; got != "from-new" {
		t.Fatalf("seq=2 derived %q, want %q", got, "from-new")
	}
}

func TestSameRecordSameGeneration(t *testing.T) {
	var e *Engine
	swap := Rule{
		ID:    "swapper",
		Match: func(Record) bool { return true },
		Derive: func(r Record) []string {
			// Dynamically replace the rule set mid-processing. The record
			// currently being processed must keep its pinned generation.
			e.SetRules([]Rule{{
				ID:     "intruder",
				Match:  func(Record) bool { return true },
				Derive: func(Record) []string { return []string{"intruder"} },
			}})
			return []string{"child-of-" + r.Message}
		},
	}
	e = NewEngine([]Rule{swap}, 3)
	recs := e.Log("root")

	for _, r := range recs {
		if r.Gen != 0 {
			t.Fatalf("record %d used gen=%d, want 0 (same record, same generation)", r.ID, r.Gen)
		}
		if strings.Contains(r.Message, "intruder") {
			t.Fatalf("record %d matched a rule from a newer generation", r.ID)
		}
	}
	// gen0 has a single rule deriving one child per record: depths 0..3.
	if len(recs) != 4 {
		t.Fatalf("got %d records, want 4 (one per depth 0..3)", len(recs))
	}
	// The next record must see the new generation.
	next := e.Log("later")
	if next[0].Gen == 0 {
		t.Fatalf("record after swap still used gen=0, want a newer generation")
	}
	for _, r := range next {
		if r.Gen != next[0].Gen {
			t.Fatalf("record after swap used gen=%d, want %d (one generation per record)",
				r.Gen, next[0].Gen)
		}
	}
}

func TestNoRematchOfOriginal(t *testing.T) {
	var mu sync.Mutex
	matched := map[int64]int{}
	self := Rule{
		ID: "self",
		Match: func(r Record) bool {
			mu.Lock()
			matched[r.ID]++
			mu.Unlock()
			return true
		},
		Derive: func(r Record) []string {
			// Derives a diagnostic with the same message as its parent: a
			// re-matching engine would loop on the original record.
			return []string{r.Message}
		},
	}
	e := NewEngine([]Rule{self}, 3)
	recs := e.Log("loop")

	if len(recs) != 4 {
		t.Fatalf("got %d records, want 4 (depths 0..3)", len(recs))
	}
	mu.Lock()
	defer mu.Unlock()
	for _, r := range recs {
		if r.Depth == 3 {
			continue // at budget: never matched
		}
		if matched[r.ID] != 1 {
			t.Fatalf("record %d matched %d times, want exactly 1", r.ID, matched[r.ID])
		}
	}
	if matched[recs[0].ID] != 1 {
		t.Fatalf("root record matched %d times, want exactly 1", matched[recs[0].ID])
	}
}

func TestDepthBudgetExplicit(t *testing.T) {
	for _, maxDepth := range []int{0, 1, 2, 5} {
		e := NewEngine([]Rule{matchAll("diag")}, maxDepth)
		recs := e.Log("root")
		deepest := 0
		truncated := 0
		for _, r := range recs {
			if r.Depth > deepest {
				deepest = r.Depth
			}
			if r.Truncated {
				truncated++
				if r.Depth != maxDepth {
					t.Fatalf("maxDepth=%d: truncated record at depth %d", maxDepth, r.Depth)
				}
			}
		}
		if deepest != maxDepth {
			t.Fatalf("maxDepth=%d: deepest record at depth %d", maxDepth, deepest)
		}
		if truncated != 1 {
			t.Fatalf("maxDepth=%d: %d truncated records, want 1", maxDepth, truncated)
		}
	}
}

func TestEngineMatchesReference(t *testing.T) {
	scenarios := []struct {
		name     string
		rules    []Rule
		maxDepth int
		message  string
	}{
		{"no rules", nil, 3, "root"},
		{"single chain", []Rule{matchAll("d")}, 4, "root"},
		{"budget zero", []Rule{matchAll("d")}, 0, "root"},
		{
			name: "two rules fan out",
			rules: []Rule{
				{ID: "a", Match: func(Record) bool { return true },
					Derive: func(r Record) []string { return []string{"a1", "a2"} }},
				{ID: "b", Match: func(r Record) bool { return r.Depth%2 == 0 },
					Derive: func(r Record) []string { return []string{"b1"} }},
			},
			maxDepth: 3,
			message:  "root",
		},
		{
			name: "conditional match",
			rules: []Rule{
				{ID: "only-roots", Match: func(r Record) bool { return r.RuleID == "" },
					Derive: func(r Record) []string { return []string{"x", "y"} }},
				{ID: "only-x", Match: func(r Record) bool { return r.Message == "x" },
					Derive: func(r Record) []string { return []string{"x"} }},
			},
			maxDepth: 5,
			message:  "root",
		},
	}

	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			e := NewEngine(sc.rules, sc.maxDepth)
			got := e.Log(sc.message)

			next := int64(1000)
			root := Record{ID: next, Seq: 1, Gen: 0, Message: sc.message, ParentID: -1}
			next++
			want := Interpret(root, sc.rules, sc.maxDepth, func() int64 {
				id := next
				next++
				return id
			})

			if canonical(got) != canonical(want) {
				t.Fatalf("engine and reference disagree\nengine:\n%s\nreference:\n%s",
					FormatTree(got), FormatTree(want))
			}
		})
	}
}

func TestFormatTree(t *testing.T) {
	rules := []Rule{
		{ID: "a", Match: func(Record) bool { return true },
			Derive: func(r Record) []string { return []string{"a1", "a2"} }},
	}
	e := NewEngine(rules, 1)
	tree := FormatTree(e.Log("root"))

	for _, want := range []string{
		`seq=1 gen=0 depth=0 rule=(root) msg="root"`,
		`depth=1 rule=a msg="a1"`,
		`depth=1 rule=a msg="a2"`,
		"[TRUNCATED: depth budget exhausted]",
		"├─ ", "└─ ",
	} {
		if !strings.Contains(tree, want) {
			t.Fatalf("tree output missing %q:\n%s", want, tree)
		}
	}
	if got := FormatTree(nil); got != "(empty)\n" {
		t.Fatalf("empty forest rendered %q, want %q", got, "(empty)\n")
	}
}

func TestConcurrentLogKeepsGenerationConsistent(t *testing.T) {
	e := NewEngine([]Rule{matchAll("d")}, 2)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			recs := e.Log(fmt.Sprintf("m%d", i))
			gen := recs[0].Gen
			seq := recs[0].Seq
			for _, r := range recs {
				if r.Gen != gen {
					t.Errorf("record %d gen=%d, root gen=%d", r.ID, r.Gen, gen)
				}
				if r.Seq != seq {
					t.Errorf("record %d seq=%d, root seq=%d", r.ID, r.Seq, seq)
				}
			}
			if i%2 == 0 {
				e.SetRules([]Rule{matchAll("d")})
			}
		}(i)
	}
	wg.Wait()
}
