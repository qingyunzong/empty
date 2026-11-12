package dataeng

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

func TestRandomizedAgainstFullPostingReference(t *testing.T) {
	for seed := int64(1); seed <= 400; seed++ {
		rng := rand.New(rand.NewSource(seed))
		documentCount := rng.Intn(19)
		documents := randomDistinctIDs(rng, documentCount)
		termCount := rng.Intn(5)
		terms := make(map[string][]Posting, termCount)
		for termIndex := 0; termIndex < termCount; termIndex++ {
			term := fmt.Sprintf("t%d", termIndex)
			for _, id := range documents {
				if rng.Intn(3) == 0 {
					continue
				}
				terms[term] = append(terms[term], Posting{
					DocumentID:   id,
					Contribution: randomRational(rng),
				})
			}
		}
		blockSize := rng.Intn(6) + 1
		metadata, store := buildForTest(t, documents, terms, blockSize)
		searcher := newSearcherForTest(t, metadata, store)

		weights := make(map[string]*big.Rat)
		for termIndex := 0; termIndex < termCount; termIndex++ {
			term := fmt.Sprintf("t%d", termIndex)
			if rng.Intn(4) != 0 {
				weights[term] = randomRational(rng)
			}
		}
		if rng.Intn(3) == 0 {
			weights["unknown"] = randomRational(rng)
		}

		excluded := make(map[uint64]struct{})
		for _, id := range documents {
			if rng.Intn(5) == 0 {
				excluded[id] = struct{}{}
			}
		}

		for k := 0; k <= len(documents)+2; k++ {
			before := readCountSnapshot(store, metadata)
			result, err := searcher.Search(weights, excluded, k)
			if err != nil {
				t.Fatalf("seed %d k %d: Search: %v", seed, k, err)
			}
			want := referenceSearch(documents, terms, weights, excluded, k)
			assertHitsEqual(t, result.Hits, want)
			if err := VerifySkipRecordsWithTerms(metadata, result.Skips, weights); err != nil {
				t.Fatalf("seed %d k %d: verify receipts: %v", seed, k, err)
			}
			verifyReceiptsAgainstPostings(t, seed, k, metadata, result.Skips, documents, terms, weights, excluded)

			totalDelta := 0
			for term, termMeta := range metadata.Terms {
				for _, block := range termMeta.Blocks {
					key := blockKey{term: term, index: block.Index}
					delta := store.ReadCount(term, block.Index) - before[key]
					if delta > 1 {
						t.Fatalf("seed %d k %d: block %q/%d read %d times in one search", seed, k, term, block.Index, delta)
					}
					totalDelta += delta
				}
			}
			if totalDelta != result.Stats.BlockReads {
				t.Fatalf("seed %d k %d: observable reads %d, Stats.BlockReads %d", seed, k, totalDelta, result.Stats.BlockReads)
			}
		}
	}
}

func verifyReceiptsAgainstPostings(t *testing.T, seed int64, k int, metadata *IndexMetadata, records []SkipRecord, documents []uint64, terms map[string][]Posting, weights map[string]*big.Rat, excluded map[uint64]struct{}) {
	t.Helper()
	byTerm := make(map[string]map[uint64]*big.Rat, len(terms))
	for term, postings := range terms {
		lookup := make(map[uint64]*big.Rat, len(postings))
		for _, posting := range postings {
			lookup[posting.DocumentID] = posting.Contribution
		}
		byTerm[term] = lookup
	}
	for recordIndex, record := range records {
		first := sort.Search(len(documents), func(i int) bool { return documents[i] >= record.MinDocumentID })
		last := sort.Search(len(documents), func(i int) bool { return documents[i] > record.MaxDocumentID }) - 1
		if first > last {
			t.Fatalf("seed %d k %d receipt %d: interval has no documents", seed, k, recordIndex)
		}
		var minimumEligible uint64
		haveMinimum := false
		for i := first; i <= last; i++ {
			id := documents[i]
			if _, skip := excluded[id]; skip {
				continue
			}
			if !haveMinimum || id < minimumEligible {
				minimumEligible = id
				haveMinimum = true
			}
			score := zeroRat()
			for term, weight := range weights {
				contribution := byTerm[term][id]
				if contribution == nil {
					contribution = zeroRat()
				}
				score = addRat(score, mulRat(weight, contribution))
			}
			if score.Cmp(record.ScoreUpperBound) > 0 {
				t.Fatalf("seed %d k %d receipt %d: actual score %s for document %d exceeds recorded bound %s", seed, k, recordIndex, score.RatString(), id, record.ScoreUpperBound.RatString())
			}
		}
		if !haveMinimum {
			t.Fatalf("seed %d k %d receipt %d: interval skipped no eligible document", seed, k, recordIndex)
		}
		if record.ScoreUpperBound.Cmp(record.KthScore) == 0 && minimumEligible < record.KthDocumentID {
			t.Fatalf("seed %d k %d receipt %d: equal bound but minimum eligible ID %d beats kth ID %d", seed, k, recordIndex, minimumEligible, record.KthDocumentID)
		}
	}
}
