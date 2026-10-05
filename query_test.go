package docset

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

func mustInsert(t *testing.T, s *Store, id string, tokens ...string) {
	t.Helper()
	if err := s.Insert(id, tokens); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyEmptySimilarityOne(t *testing.T) {
	s := NewStore()
	mustInsert(t, s, "empty")
	mustInsert(t, s, "full", "a")

	// Empty query vs empty doc: similarity 1, reaches threshold 1.
	res := s.Query(nil, Rat{Num: 1, Den: 1}, -1)
	if !res.Complete || len(res.Hits) != 1 || res.Hits[0].DocID != "empty" {
		t.Fatalf("got %+v", res)
	}
	if res.Hits[0].Score != (Rat{Num: 1, Den: 1}) {
		t.Fatalf("empty-empty score = %v, want 1/1", res.Hits[0].Score)
	}
	// Empty vs non-empty is 0 and must be pruned with a 0 certificate.
	if len(res.Pruned) != 1 || res.Pruned[0].DocID != "full" ||
		res.Pruned[0].Bound != (Rat{Num: 0, Den: 1}) {
		t.Fatalf("pruned = %+v", res.Pruned)
	}
}

func TestHitOrdering(t *testing.T) {
	s := NewStore()
	// Scores vs query {a,b}: b=1, a=1/2, c=1/2, d=1/4.
	mustInsert(t, s, "b", "a", "b")
	mustInsert(t, s, "a", "a")
	mustInsert(t, s, "c", "b")
	mustInsert(t, s, "d", "a", "x", "y")
	res := s.Query([]string{"a", "b"}, Rat{Num: 0, Den: 1}, -1)
	var order []string
	for _, h := range res.Hits {
		order = append(order, h.DocID)
	}
	// Score descending, then ID ascending: b(1) > a(1/2)=c(1/2) > d(1/4).
	want := []string{"b", "a", "c", "d"}
	if fmt.Sprint(order) != fmt.Sprint(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if res.Hits[1].Score != res.Hits[2].Score {
		t.Fatalf("tie broken by score, not ID: %v vs %v", res.Hits[1], res.Hits[2])
	}
}

func TestBudgetReturnsUnclosed(t *testing.T) {
	s := NewStore()
	for i := 0; i < 5; i++ {
		mustInsert(t, s, fmt.Sprintf("d%d", i), "a", "b")
	}
	res := s.Query([]string{"a", "b"}, Rat{Num: 1, Den: 1}, 2)
	if res.Complete {
		t.Fatal("expected incomplete result")
	}
	if len(res.Hits) != 2 || len(res.Unclosed) != 3 {
		t.Fatalf("hits=%d unclosed=%d, want 2/3", len(res.Hits), len(res.Unclosed))
	}
	for _, h := range res.Hits {
		if h.Score != (Rat{Num: 1, Den: 1}) {
			t.Fatalf("hit score = %v", h.Score)
		}
	}
	for _, u := range res.Unclosed {
		if u.Bound != (Rat{Num: 1, Den: 1}) {
			t.Fatalf("unclosed bound = %v", u.Bound)
		}
	}
	// Zero budget: everything candidate is unclosed, nothing scanned.
	res = s.Query([]string{"a", "b"}, Rat{Num: 1, Den: 1}, 0)
	if len(res.Hits) != 0 || len(res.Unclosed) != 5 {
		t.Fatalf("zero budget: hits=%d unclosed=%d", len(res.Hits), len(res.Unclosed))
	}
}

// verifyFullComparison is the independent checker: it recomputes every
// document's exact Jaccard score from scratch (public API only) and
// validates hits, pruning certificates and unclosed candidates.
func verifyFullComparison(t *testing.T, s *Store, query []string, threshold Rat, budget int, res Result) {
	t.Helper()
	qset := map[string]bool{}
	for _, tok := range query {
		qset[tok] = true
	}
	actual := map[string]Rat{}
	for _, id := range s.DocIDs() {
		toks, _ := s.Tokens(id)
		dset := map[string]bool{}
		for _, tok := range toks {
			dset[tok] = true
		}
		inter, union := jaccard(qset, dset)
		actual[id] = jaccardRat(inter, union)
	}
	var expected []string
	for id, score := range actual {
		if score.cmp(threshold) >= 0 {
			expected = append(expected, id)
		}
	}
	sort.Slice(expected, func(i, j int) bool {
		a, b := expected[i], expected[j]
		if c := actual[a].cmp(actual[b]); c != 0 {
			return c > 0
		}
		return a < b
	})

	hitSet := map[string]bool{}
	for _, h := range res.Hits {
		if h.Score != actual[h.DocID] {
			t.Fatalf("hit %s score %v, actual %v", h.DocID, h.Score, actual[h.DocID])
		}
		if h.Score.cmp(threshold) < 0 {
			t.Fatalf("hit %s below threshold", h.DocID)
		}
		hitSet[h.DocID] = true
	}
	unclosedSet := map[string]bool{}
	for _, u := range res.Unclosed {
		unclosedSet[u.DocID] = true
		if u.Bound.cmp(actual[u.DocID]) < 0 {
			t.Fatalf("unclosed %s: bound %v below actual %v", u.DocID, u.Bound, actual[u.DocID])
		}
		if u.Bound.cmp(threshold) < 0 {
			t.Fatalf("unclosed %s: bound %v below threshold %v (should be pruned)", u.DocID, u.Bound, threshold)
		}
	}
	for _, id := range res.Rejected {
		if actual[id].cmp(threshold) >= 0 {
			t.Fatalf("rejected %s actually reaches threshold (%v)", id, actual[id])
		}
		if hitSet[id] || unclosedSet[id] {
			t.Fatalf("rejected %s also reported elsewhere", id)
		}
	}
	for _, p := range res.Pruned {
		if p.Bound.cmp(actual[p.DocID]) < 0 {
			t.Fatalf("pruned %s: certificate %v below actual %v (invalid bound)", p.DocID, p.Bound, actual[p.DocID])
		}
		if p.Bound.cmp(threshold) >= 0 {
			t.Fatalf("pruned %s: certificate %v reaches threshold %v", p.DocID, p.Bound, threshold)
		}
		if hitSet[p.DocID] || unclosedSet[p.DocID] {
			t.Fatalf("pruned %s also reported elsewhere", p.DocID)
		}
	}
	// No missed hits: every expected hit is a definite hit or unclosed.
	for _, id := range expected {
		if !hitSet[id] && !unclosedSet[id] {
			t.Fatalf("missed hit %s (score %v, threshold %v)", id, actual[id], threshold)
		}
	}
	// Every document accounted for exactly once.
	total := len(res.Hits) + len(res.Rejected) + len(res.Unclosed) + len(res.Pruned)
	if total != len(actual) {
		t.Fatalf("accounted %d docs, store has %d", total, len(actual))
	}
	// Budget respected: scanned = candidates - unclosed <= budget.
	if budget >= 0 {
		scanned := len(res.Hits) + len(res.Rejected)
		if scanned > budget {
			t.Fatalf("scanned %d docs over budget %d", scanned, budget)
		}
		if len(res.Unclosed) > 0 && scanned != budget {
			t.Fatalf("unclosed candidates remain but budget not exhausted (%d/%d)", scanned, budget)
		}
	} else if len(res.Unclosed) != 0 {
		t.Fatal("unlimited budget but unclosed candidates exist")
	}
	// Completeness: full hit list must equal the expected list.
	if res.Complete {
		var got []string
		for _, h := range res.Hits {
			got = append(got, h.DocID)
		}
		if fmt.Sprint(got) != fmt.Sprint(expected) {
			t.Fatalf("complete hits = %v, want %v", got, expected)
		}
	}
	// Hits sorted by score desc, then ID.
	for i := 1; i < len(res.Hits); i++ {
		prev, cur := res.Hits[i-1], res.Hits[i]
		if c := prev.Score.cmp(cur.Score); c < 0 || (c == 0 && prev.DocID > cur.DocID) {
			t.Fatalf("hits out of order at %d: %v then %v", i, prev, cur)
		}
	}
}

func TestFullComparisonSweep(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	alphabet := []string{}
	for i := 0; i < 10; i++ {
		alphabet = append(alphabet, fmt.Sprintf("w%d", i))
	}
	randTokens := func() []string {
		n := rng.Intn(7)
		out := make([]string, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, alphabet[rng.Intn(len(alphabet))])
		}
		return out
	}
	thresholds := []Rat{
		{Num: 0, Den: 1}, {Num: 1, Den: 4}, {Num: 1, Den: 3},
		{Num: 1, Den: 2}, {Num: 2, Den: 3}, {Num: 1, Den: 1},
	}
	for trial := 0; trial < 60; trial++ {
		s := NewStore()
		nDocs := rng.Intn(12)
		for i := 0; i < nDocs; i++ {
			mustInsert(t, s, fmt.Sprintf("doc%d", i), randTokens()...)
		}
		query := randTokens()
		threshold := thresholds[rng.Intn(len(thresholds))]
		budget := -1
		if rng.Intn(2) == 0 {
			budget = rng.Intn(nDocs + 2) // sometimes too small
		}
		res := s.Query(query, threshold, budget)
		verifyFullComparison(t, s, query, threshold, budget, res)
	}
}
