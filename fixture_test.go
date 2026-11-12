package dataeng

import (
	"math"
	"math/big"
	"testing"
)

func TestBlockMaxFixtureSkipsWithoutReadingPayload(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9}
	var postings []Posting
	postings = append(postings, Posting{DocumentID: 1, Contribution: r(100, 1)})
	for id := uint64(2); id <= 9; id++ {
		postings = append(postings, Posting{DocumentID: id, Contribution: r(1, 1)})
	}
	terms := map[string][]Posting{"signal": postings}
	metadata, store := buildForTest(t, documents, terms, 1)
	searcher := newSearcherForTest(t, metadata, store)

	result, err := searcher.Search(map[string]*big.Rat{"signal": r(1, 1)}, nil, 1)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	assertHitsEqual(t, result.Hits, []Hit{{DocumentID: 1, Score: r(100, 1)}})
	if result.Stats.BlockReads != 1 {
		t.Fatalf("BlockReads = %d, want 1", result.Stats.BlockReads)
	}
	if result.Stats.SkippedIntervals < 8 {
		t.Fatalf("SkippedIntervals = %d, want at least 8", result.Stats.SkippedIntervals)
	}
	if store.TotalReads() != 1 {
		t.Fatalf("store reads = %d, want 1", store.TotalReads())
	}
	for blockIndex := 1; blockIndex <= 8; blockIndex++ {
		if count := store.ReadCount("signal", blockIndex); count != 0 {
			t.Fatalf("later block %d read %d times, want 0", blockIndex, count)
		}
	}
	if err := VerifySkipRecordsWithTerms(metadata, result.Skips, map[string]*big.Rat{"signal": r(1, 1)}); err != nil {
		t.Fatalf("verify skips: %v", err)
	}

	// Every skipped range after document 1 must cite exactly the next block
	// and an upper bound of 1, not a fabricated whole-index maximum.
	for _, record := range result.Skips {
		if record.MinDocumentID != record.MaxDocumentID || record.MinDocumentID < 2 {
			t.Fatalf("unexpected skip interval [%d,%d]", record.MinDocumentID, record.MaxDocumentID)
		}
		if len(record.TermBounds) != 1 {
			t.Fatalf("unexpected term bound count %d", len(record.TermBounds))
		}
		bound := record.TermBounds[0]
		wantBlock := int(record.MinDocumentID - 1)
		if bound.BlockIndex != wantBlock {
			t.Fatalf("block index = %d, want %d", bound.BlockIndex, wantBlock)
		}
		if bound.ContributionUpperBound.Cmp(r(1, 1)) != 0 {
			t.Fatalf("contribution bound = %s, want 1", bound.ContributionUpperBound.RatString())
		}
	}
}

func TestMisalignedBlockBoundaries(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	aPostings := []Posting{
		{1, r(3, 2)}, {2, r(2, 3)}, {3, r(7, 5)}, {4, r(1, 7)}, {5, r(9, 4)},
		{6, r(1, 9)}, {7, r(5, 2)}, {8, r(4, 3)}, {9, r(8, 7)}, {10, r(2, 5)},
	}
	bPostings := []Posting{
		{1, r(1, 8)}, {4, r(6, 5)}, {7, r(3, 2)}, {10, r(2, 1)},
	}
	terms := map[string][]Posting{"alpha": aPostings, "beta": bPostings}
	metadata, store := buildForTest(t, documents, terms, 3)
	searcher := newSearcherForTest(t, metadata, store)

	weights := map[string]*big.Rat{"alpha": r(2, 3), "beta": r(5, 4)}
	for k := 0; k <= len(documents)+1; k++ {
		result, err := searcher.Search(weights, nil, k)
		if err != nil {
			t.Fatalf("k=%d: %v", k, err)
		}
		assertHitsEqual(t, result.Hits, referenceSearch(documents, terms, weights, nil, k))
		if err := VerifySkipRecordsWithTerms(metadata, result.Skips, weights); err != nil {
			t.Fatalf("k=%d: verify skips: %v", k, err)
		}
	}
}

func TestEqualScoresUseDocumentIDTieBreak(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5}
	postings := []Posting{
		{1, r(1, 1)}, {2, r(1, 1)}, {3, r(1, 1)}, {4, r(1, 1)}, {5, r(1, 1)},
	}
	terms := map[string][]Posting{"t": postings}
	metadata, store := buildForTest(t, documents, terms, 1)
	searcher := newSearcherForTest(t, metadata, store)

	result, err := searcher.Search(map[string]*big.Rat{"t": r(1, 1)}, nil, 2)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	assertHitsEqual(t, result.Hits, []Hit{{1, r(1, 1)}, {2, r(1, 1)}})
	if len(result.Skips) == 0 {
		t.Fatalf("expected equal-bound skips after k candidates")
	}
	for _, skip := range result.Skips {
		if skip.ScoreUpperBound.Cmp(skip.KthScore) != 0 {
			t.Fatalf("expected an equal-bound skip, got bound %s kth %s", skip.ScoreUpperBound.RatString(), skip.KthScore.RatString())
		}
		if skip.MinDocumentID < skip.KthDocumentID {
			t.Fatalf("skip minimum ID %d is below kth ID %d", skip.MinDocumentID, skip.KthDocumentID)
		}
	}
	if err := VerifySkipRecordsWithTerms(metadata, result.Skips, map[string]*big.Rat{"t": r(1, 1)}); err != nil {
		t.Fatalf("verify skips: %v", err)
	}
}

func TestEqualUpperBoundWithSmallerIDIsRejected(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5}
	postings := []Posting{
		{1, r(1, 1)}, {2, r(1, 1)}, {3, r(1, 1)}, {4, r(1, 1)}, {5, r(1, 1)},
	}
	terms := map[string][]Posting{"t": postings}
	metadata, _ := buildForTest(t, documents, terms, 5)

	// This receipt is deliberately unsafe: the bound equals the kth score,
	// but document 1 is smaller than the kth ID 2 and would win the tie.  A
	// metadata-only checker must reject it even though the arithmetic and
	// block coverage are valid.
	record := SkipRecord{
		MinDocumentID: 1,
		MaxDocumentID: 5,
		TermBounds: []TermSkipBound{{
			Term:                   "t",
			Weight:                 r(1, 1),
			ContributionUpperBound: r(1, 1),
			ScoreUpperBound:        r(1, 1),
			BlockIndex:             0,
			BlockMinDocumentID:     1,
			BlockMaxDocumentID:     5,
		}},
		ScoreUpperBound: r(1, 1),
		KthScore:        r(1, 1),
		KthDocumentID:   2,
		Reason:          SkipReasonEqualThresholdNoBetterID,
	}
	if err := VerifySkipRecord(metadata, record); err == nil {
		t.Fatalf("checker accepted an equal-bound skip whose interval starts below the kth ID")
	}
}

func TestExcludedHighScoreDocuments(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5, 6}
	postings := []Posting{
		{1, r(1000, 1)}, {2, r(7, 3)}, {3, r(5, 2)}, {4, r(1, 9)}, {5, r(3, 4)}, {6, r(4, 7)},
	}
	terms := map[string][]Posting{"t": postings}
	excluded := map[uint64]struct{}{1: {}}
	weights := map[string]*big.Rat{"t": r(2, 5)}

	metadata, store := buildForTest(t, documents, terms, 2)
	searcher := newSearcherForTest(t, metadata, store)
	result, err := searcher.Search(weights, excluded, 3)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	assertHitsEqual(t, result.Hits, referenceSearch(documents, terms, weights, excluded, 3))
	for _, hit := range result.Hits {
		if hit.DocumentID == 1 {
			t.Fatalf("excluded high-score document was returned")
		}
	}
	if err := VerifySkipRecordsWithTerms(metadata, result.Skips, weights); err != nil {
		t.Fatalf("verify skips: %v", err)
	}
}

func TestEmptyUnknownAndZeroWeightQueries(t *testing.T) {
	documents := []uint64{9, 2, 5}
	terms := map[string][]Posting{
		"known": {{DocumentID: 2, Contribution: r(3, 4)}, {DocumentID: 5, Contribution: r(1, 2)}},
	}
	metadata, store := buildForTest(t, documents, terms, 1)
	searcher := newSearcherForTest(t, metadata, store)

	empty, err := searcher.Search(nil, nil, 3)
	if err != nil {
		t.Fatalf("empty query: %v", err)
	}
	assertHitsEqual(t, empty.Hits, []Hit{{2, r(0, 1)}, {5, r(0, 1)}, {9, r(0, 1)}})

	unknownWeights := map[string]*big.Rat{"missing": r(9, 2)}
	unknown, err := searcher.Search(unknownWeights, nil, 2)
	if err != nil {
		t.Fatalf("unknown term query: %v", err)
	}
	assertHitsEqual(t, unknown.Hits, []Hit{{2, r(0, 1)}, {5, r(0, 1)}})
	if unknown.Stats.BlockReads != 0 {
		t.Fatalf("unknown term caused %d block reads", unknown.Stats.BlockReads)
	}

	zeroWeights := map[string]*big.Rat{"known": r(0, 1), "missing": r(0, 5)}
	zero, err := searcher.Search(zeroWeights, nil, 3)
	if err != nil {
		t.Fatalf("zero-weight query: %v", err)
	}
	assertHitsEqual(t, zero.Hits, []Hit{{2, r(0, 1)}, {5, r(0, 1)}, {9, r(0, 1)}})
	if zero.Stats.BlockReads != 0 {
		t.Fatalf("zero-weight query caused %d block reads", zero.Stats.BlockReads)
	}
	if err := VerifySkipRecordsWithTerms(metadata, zero.Skips, zeroWeights); err != nil {
		t.Fatalf("verify zero-weight skips: %v", err)
	}

	none, err := searcher.Search(unknownWeights, nil, 0)
	if err != nil {
		t.Fatalf("k=0: %v", err)
	}
	if len(none.Hits) != 0 || len(none.Skips) != 0 {
		t.Fatalf("k=0 returned hits or skips")
	}
}

func TestZeroScorePruningWaitsForKthCandidate(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9}
	postings := make([]Posting, 0, len(documents))
	for _, id := range documents {
		postings = append(postings, Posting{DocumentID: id, Contribution: r(1, 1)})
	}
	terms := map[string][]Posting{"t": postings}
	metadata, store := buildForTest(t, documents, terms, 1)
	searcher := newSearcherForTest(t, metadata, store)
	weights := map[string]*big.Rat{"t": r(0, 1), "unknown": r(0, 3)}

	result, err := searcher.Search(weights, nil, 3)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	assertHitsEqual(t, result.Hits, []Hit{{1, r(0, 1)}, {2, r(0, 1)}, {3, r(0, 1)}})
	if result.Stats.DocumentsScored != 3 {
		t.Fatalf("DocumentsScored = %d, want exactly 3 before zero-score skipping", result.Stats.DocumentsScored)
	}
	if len(result.Skips) != 6 {
		t.Fatalf("skip count = %d, want 6", len(result.Skips))
	}
	for _, record := range result.Skips {
		if record.KthScore.Sign() != 0 || record.KthDocumentID != 3 {
			t.Fatalf("unexpected kth state: score %s id %d", record.KthScore.RatString(), record.KthDocumentID)
		}
		if record.MinDocumentID < record.KthDocumentID {
			t.Fatalf("pruned an interval starting before kth ID")
		}
	}
	if result.Stats.BlockReads != 0 {
		t.Fatalf("zero-weight query read %d blocks", result.Stats.BlockReads)
	}
	if err := VerifySkipRecordsWithTerms(metadata, result.Skips, weights); err != nil {
		t.Fatalf("verify zero-score skips: %v", err)
	}
}

func TestDocumentIDsBeyondUint32AndAtUint64Maximum(t *testing.T) {
	documents := []uint64{1 << 32, 1<<32 + 1, 1<<32 + 50, math.MaxUint64 - 2, math.MaxUint64 - 1, math.MaxUint64}
	postings := []Posting{
		{1 << 32, r(1, 2)},
		{1<<32 + 1, r(9, 3)},
		{1<<32 + 50, r(2, 5)},
		{math.MaxUint64 - 2, r(4, 3)},
		{math.MaxUint64 - 1, r(7, 6)},
		{math.MaxUint64, r(3, 7)},
	}
	terms := map[string][]Posting{"wide": postings}
	weights := map[string]*big.Rat{"wide": r(3, 7)}
	metadata, store := buildForTest(t, documents, terms, 2)
	searcher := newSearcherForTest(t, metadata, store)

	for k := 0; k <= len(documents); k++ {
		result, err := searcher.Search(weights, nil, k)
		if err != nil {
			t.Fatalf("k=%d: %v", k, err)
		}
		assertHitsEqual(t, result.Hits, referenceSearch(documents, terms, weights, nil, k))
		if err := VerifySkipRecordsWithTerms(metadata, result.Skips, weights); err != nil {
			t.Fatalf("k=%d: verify skips: %v", k, err)
		}
	}
}

func TestAllDocumentsExcluded(t *testing.T) {
	documents := []uint64{1, 2, 3}
	terms := map[string][]Posting{"t": {{1, r(5, 1)}, {2, r(4, 1)}, {3, r(3, 1)}}}
	metadata, store := buildForTest(t, documents, terms, 1)
	searcher := newSearcherForTest(t, metadata, store)
	excluded := map[uint64]struct{}{1: {}, 2: {}, 3: {}}
	result, err := searcher.Search(map[string]*big.Rat{"t": r(1, 1)}, excluded, 2)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(result.Hits) != 0 || len(result.Skips) != 0 || result.Stats.BlockReads != 0 {
		t.Fatalf("unexpected result for fully excluded directory: %+v", result)
	}
}
