package tokenindex

import (
	"fmt"
	"math/rand"
	"reflect"
	"sync"
	"testing"
)

// naiveModel is the per-document set intersection/union reference model.
type naiveModel map[DocID]map[string]struct{}

func (m naiveModel) apply(id DocID, tokens []string) {
	m[id] = dedup(tokens)
}

func (m naiveModel) remove(id DocID) {
	delete(m, id)
}

func (m naiveModel) correct(id DocID, add, del []string) {
	set := m[id]
	addSet := dedup(add)
	for t := range dedup(del) {
		if _, also := addSet[t]; !also {
			delete(set, t)
		}
	}
	for t := range addSet {
		set[t] = struct{}{}
	}
}

func (m naiveModel) query(tokens []string, th Threshold) []Hit {
	qset := dedup(tokens)
	q := len(qset)
	var hits []Hit
	for id, set := range m {
		inter := 0
		for t := range set {
			if _, ok := qset[t]; ok {
				inter++
			}
		}
		union := q + len(set) - inter
		if th.reached(inter, union) {
			hits = append(hits, Hit{ID: id, Inter: inter, Union: union})
		}
	}
	sortHits(hits)
	return hits
}

func mustAdd(t *testing.T, x *Index, id DocID, tokens ...string) {
	t.Helper()
	if err := x.Add(id, tokens); err != nil {
		t.Fatalf("Add(%d): %v", id, err)
	}
}

func TestDuplicateTokensCountedOnce(t *testing.T) {
	x := New()
	mustAdd(t, x, 1, "a", "a", "b", "b", "b")
	if n, _ := x.Len(1); n != 2 {
		t.Fatalf("Len = %d, want 2", n)
	}
	res := x.Query([]string{"a", "a", "b"}, Threshold{1, 1}, -1)
	if len(res.Hits) != 1 || res.Hits[0].ID != 1 || res.Hits[0].Inter != 2 || res.Hits[0].Union != 2 {
		t.Fatalf("unexpected hits: %+v", res.Hits)
	}
}

func TestEmptyEmptySimilarityIsOne(t *testing.T) {
	x := New()
	mustAdd(t, x, 1)      // empty doc
	mustAdd(t, x, 2, "a") // non-empty
	res := x.Query(nil, Threshold{1, 1}, -1)
	if len(res.Hits) != 1 || res.Hits[0].ID != 1 {
		t.Fatalf("empty-empty similarity must be 1, hits: %+v", res.Hits)
	}
	if len(res.Pruned) != 1 || res.Pruned[0].ID != 2 {
		t.Fatalf("doc 2 should be pruned with bound 0: %+v", res.Pruned)
	}
	// Empty vs empty ranks as score 1.
	if res.Hits[0].Union != 0 {
		t.Fatalf("empty-empty union should be 0, got %+v", res.Hits[0])
	}
}

func TestRationalThresholdBoundary(t *testing.T) {
	x := New()
	mustAdd(t, x, 1, "a", "b", "c")      // sim to {a,b} = 2/3
	mustAdd(t, x, 2, "a", "b", "c", "d") // sim to {a,b} = 2/4 = 1/2
	q := []string{"a", "b"}
	for _, th := range []Threshold{{1, 2}, {2, 4}, {50, 100}} {
		res := x.Query(q, th, -1)
		if len(res.Hits) != 2 {
			t.Fatalf("threshold %v: want 2 hits, got %+v", th, res.Hits)
		}
	}
	res := x.Query(q, Threshold{2, 3}, -1)
	if len(res.Hits) != 1 || res.Hits[0].ID != 1 {
		t.Fatalf("threshold 2/3: want only doc 1, got %+v", res.Hits)
	}
	res = x.Query(q, Threshold{3, 4}, -1)
	if len(res.Hits) != 0 {
		t.Fatalf("threshold 3/4: want no hits, got %+v", res.Hits)
	}
}

func TestResultOrderingScoreDescThenID(t *testing.T) {
	x := New()
	mustAdd(t, x, 5, "a", "b")           // 2/2 = 1
	mustAdd(t, x, 3, "a", "b")           // 2/2 = 1
	mustAdd(t, x, 4, "a", "b", "c")      // 2/3
	mustAdd(t, x, 1, "a", "b", "c", "d") // 2/4 = 1/2
	res := x.Query([]string{"a", "b"}, Threshold{1, 2}, -1)
	want := []DocID{3, 5, 4, 1}
	var got []DocID
	for _, h := range res.Hits {
		got = append(got, h.ID)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestBudgetReturnsDefiniteHitsAndUnclosed(t *testing.T) {
	x := New()
	// 6 candidates sharing token "a", plus one doc sharing nothing.
	for i := 1; i <= 6; i++ {
		mustAdd(t, x, DocID(i), "a", fmt.Sprintf("t%d", i))
	}
	mustAdd(t, x, 7, "zzz")
	res := x.Query([]string{"a"}, Threshold{1, 3}, 2)
	if !res.Exhausted {
		t.Fatalf("budget 2 over 6 candidates must be exhausted")
	}
	if res.Scanned != 2 {
		t.Fatalf("Scanned = %d, want 2", res.Scanned)
	}
	if len(res.Hits)+len(res.Unclosed) != 6 {
		t.Fatalf("hits+unclosed = %d, want 6", len(res.Hits)+len(res.Unclosed))
	}
	// Every definite hit truly meets the threshold.
	for _, h := range res.Hits {
		if !(Threshold{1, 3}).reached(h.Inter, h.Union) {
			t.Fatalf("hit %+v does not meet threshold", h)
		}
	}
	// Unclosed candidates carry verifiable, non-excluding bounds.
	for _, b := range res.Unclosed {
		if !x.VerifyBound([]string{"a"}, b) {
			t.Fatalf("unclosed certificate %+v does not verify", b)
		}
		if !b.UpperReached(Threshold{1, 3}) {
			t.Fatalf("unclosed certificate %+v excludes the doc", b)
		}
	}
	if err := x.Audit([]string{"a"}, Threshold{1, 3}, res); err != nil {
		t.Fatalf("audit: %v", err)
	}
}

func TestPruningCertificatesVerify(t *testing.T) {
	x := New()
	mustAdd(t, x, 1, "a", "b", "c", "d", "e", "f", "g", "h") // length-pruned
	mustAdd(t, x, 2, "a", "b")                               // exact hit
	mustAdd(t, x, 3, "x", "y")                               // zero overlap
	q := []string{"a", "b"}
	th := Threshold{1, 2}
	res := x.Query(q, th, -1)
	if len(res.Hits) != 1 || res.Hits[0].ID != 2 {
		t.Fatalf("hits = %+v", res.Hits)
	}
	if len(res.Pruned) != 2 {
		t.Fatalf("pruned = %+v", res.Pruned)
	}
	for _, b := range res.Pruned {
		if !x.VerifyBound(q, b) {
			t.Fatalf("certificate %+v does not verify", b)
		}
		if !b.UpperBelow(th) {
			t.Fatalf("certificate %+v does not exclude the doc", b)
		}
	}
	if err := x.Audit(q, th, res); err != nil {
		t.Fatalf("audit: %v", err)
	}
}

func TestCorrectAtomicAndMissingDoc(t *testing.T) {
	x := New()
	mustAdd(t, x, 1, "a", "b")
	before, _ := x.Tokens(1)
	if err := x.Correct(99, []string{"a"}, nil); err == nil {
		t.Fatalf("Correct on missing doc must fail")
	}
	after, _ := x.Tokens(1)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("failed Correct mutated the index")
	}
	if err := x.Correct(1, []string{"c"}, []string{"a"}); err != nil {
		t.Fatalf("Correct: %v", err)
	}
	got, _ := x.Tokens(1)
	if want := []string{"b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("tokens = %v, want %v", got, want)
	}
	if n, _ := x.Len(1); n != 2 {
		t.Fatalf("length index = %d, want 2", n)
	}
	if err := x.CheckInvariants(); err != nil {
		t.Fatalf("invariants: %v", err)
	}
	// Inverted index must route the corrected token.
	res := x.Query([]string{"b", "c"}, Threshold{1, 1}, -1)
	if len(res.Hits) != 1 || res.Hits[0].ID != 1 {
		t.Fatalf("query after correction: %+v", res.Hits)
	}
}

func TestConcurrentCorrectAndQuery(t *testing.T) {
	x := New()
	for i := 0; i < 32; i++ {
		mustAdd(t, x, DocID(i), "base", fmt.Sprintf("tok%d", i))
	}
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				id := DocID((w + i) % 32)
				_ = x.Correct(id, []string{fmt.Sprintf("w%d", w)}, []string{"base"})
				_ = x.Correct(id, []string{"base"}, []string{fmt.Sprintf("w%d", w)})
				_ = x.Query([]string{"base"}, Threshold{1, 2}, 4)
			}
		}(w)
	}
	wg.Wait()
	if err := x.CheckInvariants(); err != nil {
		t.Fatalf("invariants after concurrent corrections: %v", err)
	}
}

// TestModelCrossCheck drives random add/remove/correct operations and
// reconciles the index against the per-document intersection/union model
// after every step, including the independent full-comparison audit.
func TestModelCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	x := New()
	model := naiveModel{}
	vocab := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
	randTokens := func() []string {
		n := rng.Intn(5)
		out := make([]string, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, vocab[rng.Intn(len(vocab))])
		}
		return out
	}
	thresholds := []Threshold{{0, 1}, {1, 4}, {1, 3}, {1, 2}, {2, 3}, {1, 1}}
	var live []DocID
	nextID := DocID(1)
	for step := 0; step < 400; step++ {
		switch rng.Intn(4) {
		case 0, 1: // add
			toks := randTokens()
			if err := x.Add(nextID, toks); err != nil {
				t.Fatalf("step %d: Add: %v", step, err)
			}
			model.apply(nextID, toks)
			live = append(live, nextID)
			nextID++
		case 2: // remove
			if len(live) == 0 {
				continue
			}
			i := rng.Intn(len(live))
			id := live[i]
			live = append(live[:i], live[i+1:]...)
			if err := x.Remove(id); err != nil {
				t.Fatalf("step %d: Remove: %v", step, err)
			}
			model.remove(id)
		case 3: // correct
			if len(live) == 0 {
				continue
			}
			id := live[rng.Intn(len(live))]
			add, del := randTokens(), randTokens()
			if err := x.Correct(id, add, del); err != nil {
				t.Fatalf("step %d: Correct: %v", step, err)
			}
			model.correct(id, add, del)
		}
		if err := x.CheckInvariants(); err != nil {
			t.Fatalf("step %d: invariants: %v", step, err)
		}
		// Reconcile queries against the naive per-document model.
		q := randTokens()
		for _, th := range thresholds {
			res := x.Query(q, th, -1)
			want := model.query(q, th)
			if !reflect.DeepEqual(res.Hits, want) {
				t.Fatalf("step %d: query %q th %v: hits %+v, model %+v", step, q, th, res.Hits, want)
			}
			if len(res.Unclosed) != 0 {
				t.Fatalf("step %d: unlimited budget must close all candidates", step)
			}
			if err := x.Audit(q, th, res); err != nil {
				t.Fatalf("step %d: audit: %v", step, err)
			}
		}
	}
}

// TestAuditAcrossBudgets runs the independent full comparison for every
// budget level and confirms no hit is ever missed and all bounds hold.
func TestAuditAcrossBudgets(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	x := New()
	vocab := []string{"a", "b", "c", "d", "e"}
	for i := DocID(1); i <= 40; i++ {
		n := rng.Intn(4)
		toks := make([]string, 0, n)
		for j := 0; j < n; j++ {
			toks = append(toks, vocab[rng.Intn(len(vocab))])
		}
		mustAdd(t, x, i, toks...)
	}
	mustAdd(t, x, 100) // empty doc
	queries := [][]string{{"a"}, {"a", "b"}, {"c", "d", "e"}, {}, {"a", "a", "b"}}
	thresholds := []Threshold{{0, 1}, {1, 4}, {1, 2}, {3, 4}, {1, 1}}
	for _, q := range queries {
		for _, th := range thresholds {
			truth := x.BruteForce(q, th)
			for budget := -1; budget <= 8; budget++ {
				res := x.Query(q, th, budget)
				if err := x.Audit(q, th, res); err != nil {
					t.Fatalf("q=%q th=%v budget=%d: %v", q, th, budget, err)
				}
				// No missed hits: every true hit is a hit or unclosed.
				decided := make(map[DocID]bool)
				for _, h := range res.Hits {
					decided[h.ID] = true
				}
				for _, b := range res.Unclosed {
					decided[b.ID] = true
				}
				for _, h := range truth {
					if !decided[h.ID] {
						t.Fatalf("q=%q th=%v budget=%d: missed hit %d", q, th, budget, h.ID)
					}
				}
				// With unlimited budget the result must equal the truth.
				if budget < 0 && !reflect.DeepEqual(res.Hits, truth) {
					t.Fatalf("q=%q th=%v: hits %+v, truth %+v", q, th, res.Hits, truth)
				}
			}
		}
	}
}

func TestInvalidThresholdPanics(t *testing.T) {
	x := New()
	defer func() {
		if recover() == nil {
			t.Fatalf("expected panic for invalid threshold")
		}
	}()
	x.Query([]string{"a"}, Threshold{3, 2}, -1)
}
