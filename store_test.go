package docset

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// model is the naive per-document set reference implementation.
type model map[string]map[string]bool

func (m model) insert(id string, tokens []string) {
	set := map[string]bool{}
	for _, t := range tokens {
		set[t] = true
	}
	m[id] = set
}

func (m model) correct(id string, add, remove []string) {
	for _, t := range remove {
		delete(m[id], t)
	}
	for _, t := range add {
		m[id][t] = true
	}
}

func (m model) sortedTokens(id string) []string {
	out := []string{}
	for t := range m[id] {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func (m model) sortedIDs() []string {
	out := []string{}
	for id := range m {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// jaccard is the independent intersection/union reference.
func jaccard(a, b map[string]bool) (inter, union int64) {
	for t := range a {
		if b[t] {
			inter++
		}
	}
	return inter, int64(len(a)+len(b)) - inter
}

// checkAgainstModel verifies the document sets and rebuilds both
// indexes from scratch to confirm they were maintained atomically.
func checkAgainstModel(t *testing.T, s *Store, m model) {
	t.Helper()
	if got, want := s.DocIDs(), m.sortedIDs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("DocIDs = %v, want %v", got, want)
	}
	for id := range m {
		got, ok := s.Tokens(id)
		if !ok {
			t.Fatalf("Tokens(%q) missing", id)
		}
		if want := m.sortedTokens(id); !reflect.DeepEqual(got, want) {
			t.Fatalf("Tokens(%q) = %v, want %v", id, got, want)
		}
		if n, _ := s.Len(id); n != len(m[id]) {
			t.Fatalf("Len(%q) = %d, want %d", id, n, len(m[id]))
		}
	}
	// Rebuild inverted index from scratch and compare.
	wantInv := map[string]map[string]struct{}{}
	for id, set := range m {
		for tok := range set {
			posting := wantInv[tok]
			if posting == nil {
				posting = map[string]struct{}{}
				wantInv[tok] = posting
			}
			posting[id] = struct{}{}
		}
	}
	if !reflect.DeepEqual(s.inv, wantInv) {
		t.Fatalf("inverted index mismatch:\n got %v\nwant %v", s.inv, wantInv)
	}
	// Rebuild length index from scratch and compare.
	wantLen := map[int]map[string]struct{}{}
	for id, set := range m {
		bucket := wantLen[len(set)]
		if bucket == nil {
			bucket = map[string]struct{}{}
			wantLen[len(set)] = bucket
		}
		bucket[id] = struct{}{}
	}
	if !reflect.DeepEqual(s.byLen, wantLen) {
		t.Fatalf("length index mismatch:\n got %v\nwant %v", s.byLen, wantLen)
	}
	for id, n := range s.lengths {
		if n != len(m[id]) {
			t.Fatalf("lengths[%q] = %d, want %d", id, n, len(m[id]))
		}
	}
}

func TestInsertDeleteErrors(t *testing.T) {
	s := NewStore()
	if err := s.Insert("a", []string{"x", "x", "y"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Insert("a", nil); err != ErrDocExists {
		t.Fatalf("duplicate insert: got %v", err)
	}
	if err := s.Delete("b"); err != ErrDocMissing {
		t.Fatalf("delete missing: got %v", err)
	}
	if err := s.CorrectTokens("b", []string{"x"}, nil); err != ErrDocMissing {
		t.Fatalf("correct missing: got %v", err)
	}
	tokens, _ := s.Tokens("a")
	if want := []string{"x", "y"}; !reflect.DeepEqual(tokens, want) {
		t.Fatalf("dedup: got %v, want %v", tokens, want)
	}
	if err := s.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if ids := s.DocIDs(); len(ids) != 0 {
		t.Fatalf("store not empty: %v", ids)
	}
}

func TestCorrectTokensAtomic(t *testing.T) {
	s := NewStore()
	m := model{}
	s.Insert("d", []string{"a", "b", "c"})
	m.insert("d", []string{"a", "b", "c"})

	// Failed correction must leave every index untouched.
	before := fmt.Sprintf("%v|%v|%v", s.inv, s.byLen, s.lengths)
	if err := s.CorrectTokens("ghost", []string{"z"}, nil); err != ErrDocMissing {
		t.Fatalf("got %v", err)
	}
	after := fmt.Sprintf("%v|%v|%v", s.inv, s.byLen, s.lengths)
	if before != after {
		t.Fatal("failed correction mutated indexes")
	}

	// Length-changing correction moves the doc between length buckets.
	if err := s.CorrectTokens("d", []string{"x", "y"}, []string{"a"}); err != nil {
		t.Fatal(err)
	}
	m.correct("d", []string{"x", "y"}, []string{"a"})
	checkAgainstModel(t, s, m)

	// No-op correction keeps indexes consistent.
	if err := s.CorrectTokens("d", []string{"b"}, []string{"nope"}); err != nil {
		t.Fatal(err)
	}
	m.correct("d", []string{"b"}, []string{"nope"})
	checkAgainstModel(t, s, m)
}

func TestRandomizedModelCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	alphabet := []string{}
	for i := 0; i < 12; i++ {
		alphabet = append(alphabet, fmt.Sprintf("t%d", i))
	}
	randTokens := func() []string {
		n := rng.Intn(8)
		out := make([]string, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, alphabet[rng.Intn(len(alphabet))])
		}
		return out
	}

	s := NewStore()
	m := model{}
	for step := 0; step < 400; step++ {
		id := fmt.Sprintf("doc%d", rng.Intn(15))
		switch rng.Intn(4) {
		case 0, 1: // insert (may collide) or re-insert after delete
			if _, ok := m[id]; ok {
				if err := s.Insert(id, randTokens()); err != ErrDocExists {
					t.Fatalf("step %d: insert dup: %v", step, err)
				}
				continue
			}
			toks := randTokens()
			if err := s.Insert(id, toks); err != nil {
				t.Fatalf("step %d: %v", step, err)
			}
			m.insert(id, toks)
		case 2: // delete
			if _, ok := m[id]; !ok {
				continue
			}
			if err := s.Delete(id); err != nil {
				t.Fatalf("step %d: %v", step, err)
			}
			delete(m, id)
		case 3: // branch token correction
			if _, ok := m[id]; !ok {
				continue
			}
			add, remove := randTokens(), randTokens()
			if err := s.CorrectTokens(id, add, remove); err != nil {
				t.Fatalf("step %d: %v", step, err)
			}
			m.correct(id, add, remove)
		}
		checkAgainstModel(t, s, m)

		// Cross-check scores against the per-document
		// intersection/union model: threshold 0 and unlimited
		// budget make every document a hit with its exact score.
		q := randTokens()
		qset := map[string]bool{}
		for _, tok := range q {
			qset[tok] = true
		}
		res := s.Query(q, Rat{Num: 0, Den: 1}, -1)
		if !res.Complete || len(res.Unclosed) != 0 || len(res.Pruned) != 0 {
			t.Fatalf("step %d: threshold-0 query not exhaustive", step)
		}
		if len(res.Hits) != len(m) {
			t.Fatalf("step %d: %d hits, want %d", step, len(res.Hits), len(m))
		}
		for _, h := range res.Hits {
			inter, union := jaccard(qset, m[h.DocID])
			if want := jaccardRat(inter, union); h.Score != want {
				t.Fatalf("step %d: score(%s) = %v, want %v", step, h.DocID, h.Score, want)
			}
		}
	}
}
