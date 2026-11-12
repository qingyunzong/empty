package dataeng

import (
	"math/big"
	"math/rand"
	"sort"
	"strconv"
	"testing"
)

func r(n, d int64) *big.Rat {
	return big.NewRat(n, d)
}

func buildForTest(t *testing.T, documents []uint64, terms map[string][]Posting, blockSize int) (*IndexMetadata, *MemoryStore) {
	t.Helper()
	store := NewMemoryStore()
	metadata, err := BuildIndex(documents, terms, blockSize, store)
	if err != nil {
		t.Fatalf("BuildIndex: %v", err)
	}
	return metadata, store
}

func newSearcherForTest(t *testing.T, metadata *IndexMetadata, store BlockReader) *Searcher {
	t.Helper()
	searcher, err := NewSearcher(metadata, store)
	if err != nil {
		t.Fatalf("NewSearcher: %v", err)
	}
	return searcher
}

// referenceSearch uses the original posting lists directly.  It shares no
// query code with Searcher.
func referenceSearch(documents []uint64, terms map[string][]Posting, weights map[string]*big.Rat, excluded map[uint64]struct{}, k int) []Hit {
	if k == 0 {
		return nil
	}
	byTerm := make(map[string]map[uint64]*big.Rat, len(terms))
	for term, postings := range terms {
		lookup := make(map[uint64]*big.Rat, len(postings))
		for _, posting := range postings {
			lookup[posting.DocumentID] = posting.Contribution
		}
		byTerm[term] = lookup
	}
	hits := make([]Hit, 0, len(documents))
	for _, id := range documents {
		if _, skip := excluded[id]; skip {
			continue
		}
		score := zeroRat()
		for term, weight := range weights {
			lookup := byTerm[term]
			contribution := lookup[id]
			if contribution == nil {
				contribution = zeroRat()
			}
			score = addRat(score, mulRat(weight, contribution))
		}
		hits = append(hits, Hit{DocumentID: id, Score: score})
	}
	sort.Slice(hits, func(i, j int) bool {
		cmp := hits[i].Score.Cmp(hits[j].Score)
		if cmp != 0 {
			return cmp > 0
		}
		return hits[i].DocumentID < hits[j].DocumentID
	})
	if len(hits) > k {
		hits = hits[:k]
	}
	return hits
}

func assertHitsEqual(t *testing.T, got, want []Hit) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d hits, want %d\n got: %v\nwant: %v", len(got), len(want), formatHits(got), formatHits(want))
	}
	for i := range want {
		if got[i].DocumentID != want[i].DocumentID {
			t.Fatalf("hit %d: got ID %d, want ID %d\n got: %v\nwant: %v", i, got[i].DocumentID, want[i].DocumentID, formatHits(got), formatHits(want))
		}
		if got[i].Score.Cmp(want[i].Score) != 0 {
			t.Fatalf("hit %d ID %d: got score %s, want %s", i, got[i].DocumentID, got[i].Score.RatString(), want[i].Score.RatString())
		}
	}
}

func formatHits(hits []Hit) string {
	out := ""
	for i, hit := range hits {
		if i > 0 {
			out += ", "
		}
		out += "(" + strconv.FormatUint(hit.DocumentID, 10) + ":" + hit.Score.RatString() + ")"
	}
	return out
}

func randomDistinctIDs(rng *rand.Rand, count int) []uint64 {
	ids := make([]uint64, 0, count)
	seen := make(map[uint64]struct{}, count)
	for len(ids) < count {
		id := uint64(rng.Intn(1000))
		if rng.Intn(4) == 0 {
			id += 1 << 32
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func randomRational(rng *rand.Rand) *big.Rat {
	numerator := int64(rng.Intn(21))
	denominator := int64(rng.Intn(7) + 1)
	return big.NewRat(numerator, denominator)
}

func clonePostingsForTest(postings []Posting) []Posting {
	return copyPostings(postings)
}

func readCountSnapshot(store *MemoryStore, metadata *IndexMetadata) map[blockKey]int {
	counts := make(map[blockKey]int)
	for term, termMeta := range metadata.Terms {
		for _, block := range termMeta.Blocks {
			counts[blockKey{term: term, index: block.Index}] = store.ReadCount(term, block.Index)
		}
	}
	return counts
}
