package dataeng

import (
	"math/big"
	"testing"
)

func TestSkipReceiptTamperingIsRejected(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5, 6, 7, 8, 9}
	var postings []Posting
	postings = append(postings, Posting{DocumentID: 1, Contribution: r(100, 1)})
	for id := uint64(2); id <= 9; id++ {
		postings = append(postings, Posting{DocumentID: id, Contribution: r(1, 1)})
	}
	metadata, _ := buildForTest(t, documents, map[string][]Posting{"signal": postings}, 1)

	valid := SkipRecord{
		MinDocumentID: 2,
		MaxDocumentID: 2,
		TermBounds: []TermSkipBound{{
			Term:                   "signal",
			Weight:                 r(1, 1),
			ContributionUpperBound: r(1, 1),
			ScoreUpperBound:        r(1, 1),
			BlockIndex:             1,
			BlockMinDocumentID:     2,
			BlockMaxDocumentID:     2,
		}},
		ScoreUpperBound: r(1, 1),
		KthScore:        r(100, 1),
		KthDocumentID:   1,
		Reason:          SkipReasonBelowThreshold,
	}
	if err := VerifySkipRecord(metadata, valid); err != nil {
		t.Fatalf("valid receipt rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*SkipRecord)
	}{
		{"contribution bound too small", func(rec *SkipRecord) { rec.TermBounds[0].ContributionUpperBound = r(1, 2) }},
		{"contribution bound too large", func(rec *SkipRecord) { rec.TermBounds[0].ContributionUpperBound = r(2, 1) }},
		{"wrong block index", func(rec *SkipRecord) { rec.TermBounds[0].BlockIndex = 0 }},
		{"nonexistent block index", func(rec *SkipRecord) { rec.TermBounds[0].BlockIndex = 99 }},
		{"block range does not cover interval", func(rec *SkipRecord) {
			rec.MaxDocumentID = 3
		}},
		{"recorded block range tampered", func(rec *SkipRecord) { rec.TermBounds[0].BlockMaxDocumentID = 3 }},
		{"term score arithmetic tampered", func(rec *SkipRecord) { rec.TermBounds[0].ScoreUpperBound = r(3, 2) }},
		{"total bound tampered", func(rec *SkipRecord) { rec.ScoreUpperBound = r(1, 2) }},
		{"reason tampered", func(rec *SkipRecord) { rec.Reason = SkipReasonEqualThresholdNoBetterID }},
		{"kth document outside directory", func(rec *SkipRecord) { rec.KthDocumentID = 10 }},
		{"inverted interval", func(rec *SkipRecord) { rec.MinDocumentID, rec.MaxDocumentID = 3, 2 }},
		{"duplicate term", func(rec *SkipRecord) {
			duplicate := rec.TermBounds[0]
			rec.TermBounds = append(rec.TermBounds, duplicate)
		}},
		{"interval has no document", func(rec *SkipRecord) {
			// Document IDs are 1..9.  Shifting beyond the directory also
			// breaks block coverage, but the checker should still reject it.
			rec.MinDocumentID, rec.MaxDocumentID = 20, 21
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rec := cloneSkipRecord(valid)
			test.mutate(&rec)
			if err := VerifySkipRecord(metadata, rec); err == nil {
				t.Fatalf("checker accepted tampered receipt")
			}
		})
	}
}

func TestSkipReceiptWithNoCoveringBlock(t *testing.T) {
	documents := []uint64{1, 2, 3}
	metadata, _ := buildForTest(t, documents, map[string][]Posting{
		"t": {{DocumentID: 2, Contribution: r(5, 1)}},
	}, 1)
	record := SkipRecord{
		MinDocumentID: 1,
		MaxDocumentID: 1,
		TermBounds: []TermSkipBound{{
			Term:                   "t",
			Weight:                 r(2, 3),
			ContributionUpperBound: r(0, 1),
			ScoreUpperBound:        r(0, 1),
			BlockIndex:             -1,
		}},
		ScoreUpperBound: r(0, 1),
		KthScore:        r(0, 1),
		KthDocumentID:   1,
		Reason:          SkipReasonEqualThresholdNoBetterID,
	}
	if err := VerifySkipRecord(metadata, record); err != nil {
		t.Fatalf("valid gap receipt rejected: %v", err)
	}

	record.TermBounds[0].ContributionUpperBound = r(1, 2)
	record.TermBounds[0].ScoreUpperBound = r(1, 3)
	record.ScoreUpperBound = r(1, 3)
	if err := VerifySkipRecord(metadata, record); err == nil {
		t.Fatalf("checker accepted a non-zero bound for an empty interval block")
	}
}

func TestQueryAwareReceiptVerificationRequiresAllTerms(t *testing.T) {
	documents := []uint64{1, 2, 3}
	terms := map[string][]Posting{
		"a": {{1, r(1, 1)}, {2, r(1, 1)}, {3, r(1, 1)}},
		"b": {{1, r(1, 2)}, {3, r(1, 2)}},
	}
	metadata, store := buildForTest(t, documents, terms, 1)
	searcher := newSearcherForTest(t, metadata, store)
	weights := map[string]*big.Rat{"a": r(1, 2), "b": r(3, 5), "unknown": r(7, 9)}
	result, err := searcher.Search(weights, nil, 1)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(result.Skips) == 0 {
		t.Fatalf("expected skips")
	}
	if err := VerifySkipRecordsWithTerms(metadata, result.Skips, weights); err != nil {
		t.Fatalf("full query-aware verification: %v", err)
	}
	partial := map[string]*big.Rat{"a": r(1, 2), "b": r(3, 5)}
	if err := VerifySkipRecordsWithTerms(metadata, result.Skips, partial); err == nil {
		t.Fatalf("checker accepted a receipt missing a query term")
	}
}

func cloneSkipRecord(record SkipRecord) SkipRecord {
	out := SkipRecord{
		MinDocumentID:   record.MinDocumentID,
		MaxDocumentID:   record.MaxDocumentID,
		ScoreUpperBound: cloneRat(record.ScoreUpperBound),
		KthScore:        cloneRat(record.KthScore),
		KthDocumentID:   record.KthDocumentID,
		Reason:          record.Reason,
		TermBounds:      make([]TermSkipBound, len(record.TermBounds)),
	}
	for i, bound := range record.TermBounds {
		out.TermBounds[i] = TermSkipBound{
			Term:                   bound.Term,
			Weight:                 cloneRat(bound.Weight),
			ContributionUpperBound: cloneRat(bound.ContributionUpperBound),
			ScoreUpperBound:        cloneRat(bound.ScoreUpperBound),
			BlockIndex:             bound.BlockIndex,
			BlockMinDocumentID:     bound.BlockMinDocumentID,
			BlockMaxDocumentID:     bound.BlockMaxDocumentID,
		}
	}
	return out
}
