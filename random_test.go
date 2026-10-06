package segidx

import (
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// evalModel is the reference implementation: it answers queries by scanning
// the tokenized original text of every visible document, word by word.
func evalModel(q Query, docs map[string]string) []string {
	collect := func(pred func(tokens []string) bool) []string {
		var out []string
		for id, text := range docs {
			if pred(Tokenize(text)) {
				out = append(out, id)
			}
		}
		sort.Strings(out)
		return out
	}
	switch q := q.(type) {
	case termQuery:
		return collect(func(toks []string) bool {
			for _, t := range toks {
				if t == q.term {
					return true
				}
			}
			return false
		})
	case phraseQuery:
		return collect(func(toks []string) bool {
			if len(q.terms) == 0 {
				return false
			}
			for i := 0; i+len(q.terms) <= len(toks); i++ {
				ok := true
				for j, term := range q.terms {
					if term == "" || toks[i+j] != term {
						ok = false
						break
					}
				}
				if ok {
					return true
				}
			}
			return false
		})
	case andQuery:
		if len(q.qs) == 0 {
			return nil
		}
		acc := map[string]bool{}
		for _, id := range evalModel(q.qs[0], docs) {
			acc[id] = true
		}
		for _, sub := range q.qs[1:] {
			m := map[string]bool{}
			for _, id := range evalModel(sub, docs) {
				m[id] = true
			}
			for id := range acc {
				if !m[id] {
					delete(acc, id)
				}
			}
		}
		out := make([]string, 0, len(acc))
		for id := range acc {
			out = append(out, id)
		}
		sort.Strings(out)
		return out
	case orQuery:
		set := map[string]bool{}
		for _, sub := range q.qs {
			for _, id := range evalModel(sub, docs) {
				set[id] = true
			}
		}
		out := make([]string, 0, len(set))
		for id := range set {
			out = append(out, id)
		}
		sort.Strings(out)
		return out
	case notQuery:
		excluded := map[string]bool{}
		for _, id := range evalModel(q.q, docs) {
			excluded[id] = true
		}
		return complement(docs, excluded)
	default:
		panic("unknown query type")
	}
}

func complement(docs map[string]string, excluded map[string]bool) []string {
	var out []string
	for id := range docs {
		if !excluded[id] {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

func randText(rng *rand.Rand, vocab []string) string {
	n := 2 + rng.Intn(11)
	seps := []string{" ", " ", " ", ", ", ". ", " - "}
	var b strings.Builder
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(seps[rng.Intn(len(seps))])
		}
		tok := vocab[rng.Intn(len(vocab))]
		if rng.Intn(4) == 0 {
			tok = strings.ToUpper(tok)
		}
		b.WriteString(tok)
	}
	return b.String()
}

func randQuery(rng *rand.Rand, vocab []string, depth int) Query {
	if depth <= 0 {
		return Term(vocab[rng.Intn(len(vocab))])
	}
	switch rng.Intn(10) {
	case 0, 1, 2, 3, 4:
		return Term(vocab[rng.Intn(len(vocab))])
	case 5, 6:
		n := 2 + rng.Intn(2)
		terms := make([]string, n)
		for i := range terms {
			terms[i] = vocab[rng.Intn(len(vocab))]
		}
		return Phrase(terms...)
	case 7:
		return And(randQuery(rng, vocab, depth-1), randQuery(rng, vocab, depth-1))
	case 8:
		return Or(randQuery(rng, vocab, depth-1), randQuery(rng, vocab, depth-1))
	default:
		return Not(randQuery(rng, vocab, depth-1))
	}
}

func cloneModel(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// TestRandomizedAgainstModel hammers the index with random adds, updates,
// deletes, snapshots, and compactions, and after every step compares random
// query results against a brute-force word-by-word scan of the original
// texts. Deleted documents must never reappear, including after compaction.
func TestRandomizedAgainstModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	vocab := []string{"ant", "bee", "cat", "dog", "elk", "fox", "gnu", "hen", "owl", "pig", "rat", "yak"}
	ids := []string{"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"}

	ix := New()
	live := map[string]string{}
	type snap struct {
		s     *Snapshot
		model map[string]string
	}
	var snaps []snap

	check := func(step int) {
		for i := 0; i < 4; i++ {
			q := randQuery(rng, vocab, 2)
			if got, want := ix.Snapshot().Search(q), evalModel(q, live); !equalIDs(got, want) {
				t.Fatalf("step %d: live query mismatch: got %v want %v", step, got, want)
			}
			for j, sn := range snaps {
				if got, want := sn.s.Search(q), evalModel(q, sn.model); !equalIDs(got, want) {
					t.Fatalf("step %d: snapshot %d mismatch: got %v want %v", step, j, got, want)
				}
			}
		}
	}

	for step := 0; step < 400; step++ {
		switch op := rng.Intn(100); {
		case op < 45: // add or update 1-3 documents
			n := 1 + rng.Intn(3)
			docs := make([]Document, n)
			for i := range docs {
				id := ids[rng.Intn(len(ids))]
				docs[i] = Document{ID: id, Text: randText(rng, vocab)}
				live[id] = docs[i].Text
			}
			ix.Add(docs...)
		case op < 60: // delete 1-2 documents
			n := 1 + rng.Intn(2)
			del := make([]string, 0, n)
			for i := 0; i < n; i++ {
				id := ids[rng.Intn(len(ids))]
				del = append(del, id)
				delete(live, id)
			}
			ix.Delete(del...)
		case op < 70: // take a snapshot
			snaps = append(snaps, snap{ix.Snapshot(), cloneModel(live)})
			if len(snaps) > 5 {
				snaps = snaps[1:]
			}
		case op < 80: // full compaction
			ix.Compact()
		case op < 90: // partial merge of the oldest segments
			if n := ix.NumSegments(); n > 1 {
				ix.MergeOldest(1 + rng.Intn(n))
			}
		}
		check(step)
	}

	// Final: compact everything and verify once more that the live model
	// (with all deletions applied) is exactly what the index reports.
	ix.Compact()
	for i := 0; i < 50; i++ {
		q := randQuery(rng, vocab, 3)
		if got, want := ix.Snapshot().Search(q), evalModel(q, live); !equalIDs(got, want) {
			t.Fatalf("post-compact mismatch: got %v want %v", got, want)
		}
	}
	if got, want := ix.Snapshot().Search(Not(Term("zzz-not-a-term"))), sortedKeys(live); !equalIDs(got, want) {
		t.Fatalf("post-compact full scan: got %v want %v", got, want)
	}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
