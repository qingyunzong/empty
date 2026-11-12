package dataeng

import (
	"fmt"
	"math/big"
	"sort"
)

// VerifySkipRecords checks every pruning receipt using only the index metadata
// and the receipt itself.  It verifies block coverage, per-term bounds, exact
// rational arithmetic, the total bound, and the score/ID pruning rule.
func VerifySkipRecords(metadata *IndexMetadata, records []SkipRecord) error {
	for i := range records {
		if err := VerifySkipRecord(metadata, records[i]); err != nil {
			return fmt.Errorf("skip record %d: %w", i, err)
		}
	}
	return nil
}

// VerifySkipRecordsWithTerms additionally verifies that every query term,
// including unknown and zero-weight terms, has exactly one bound in each
// receipt and that the recorded weight matches the query.
func VerifySkipRecordsWithTerms(metadata *IndexMetadata, records []SkipRecord, queryWeights map[string]*big.Rat) error {
	for i := range records {
		if err := VerifySkipRecordWithTerms(metadata, records[i], queryWeights); err != nil {
			return fmt.Errorf("skip record %d: %w", i, err)
		}
	}
	return nil
}

// VerifySkipRecord is the metadata-only form of pruning verification.
func VerifySkipRecord(metadata *IndexMetadata, record SkipRecord) error {
	meta, err := cloneMetadata(metadata)
	if err != nil {
		return fmt.Errorf("invalid metadata: %w", err)
	}
	if record.MinDocumentID > record.MaxDocumentID {
		return fmt.Errorf("inverted interval [%d,%d]", record.MinDocumentID, record.MaxDocumentID)
	}
	first := firstDocumentAtLeast(meta.Documents, record.MinDocumentID)
	if first >= len(meta.Documents) || meta.Documents[first] > record.MaxDocumentID {
		return fmt.Errorf("interval [%d,%d] contains no directory document", record.MinDocumentID, record.MaxDocumentID)
	}
	if err := validateNonNegativeRat("kth score", record.KthScore); err != nil {
		return err
	}
	if !containsDocument(meta.Documents, record.KthDocumentID) {
		return fmt.Errorf("kth document ID %d is not in the directory", record.KthDocumentID)
	}
	if err := validateNonNegativeRat("total score upper bound", record.ScoreUpperBound); err != nil {
		return err
	}

	seenTerms := make(map[string]struct{}, len(record.TermBounds))
	sum := zeroRat()
	for _, bound := range record.TermBounds {
		if _, duplicate := seenTerms[bound.Term]; duplicate {
			return fmt.Errorf("duplicate term bound %q", bound.Term)
		}
		seenTerms[bound.Term] = struct{}{}
		if err := validateNonNegativeRat(fmt.Sprintf("term %q weight", bound.Term), bound.Weight); err != nil {
			return err
		}
		if err := validateNonNegativeRat(fmt.Sprintf("term %q contribution bound", bound.Term), bound.ContributionUpperBound); err != nil {
			return err
		}
		if err := validateNonNegativeRat(fmt.Sprintf("term %q score bound", bound.Term), bound.ScoreUpperBound); err != nil {
			return err
		}
		expectedScore := mulRat(bound.Weight, bound.ContributionUpperBound)
		if expectedScore.Cmp(bound.ScoreUpperBound) != 0 {
			return fmt.Errorf("term %q: weight * contribution = %s, but score bound is %s", bound.Term, expectedScore.RatString(), bound.ScoreUpperBound.RatString())
		}

		termMeta, known := meta.Terms[bound.Term]
		if bound.BlockIndex < 0 {
			if bound.ContributionUpperBound.Sign() != 0 {
				return fmt.Errorf("term %q: no block recorded but contribution bound is %s", bound.Term, bound.ContributionUpperBound.RatString())
			}
			if known {
				for _, block := range termMeta.Blocks {
					if blocksIntersect(block, record.MinDocumentID, record.MaxDocumentID) {
						return fmt.Errorf("term %q: interval [%d,%d] intersects unrecorded block %d [%d,%d]", bound.Term, record.MinDocumentID, record.MaxDocumentID, block.Index, block.MinDocumentID, block.MaxDocumentID)
					}
				}
			}
			if bound.BlockMinDocumentID != 0 || bound.BlockMaxDocumentID != 0 {
				return fmt.Errorf("term %q: no block recorded but block range is [%d,%d]", bound.Term, bound.BlockMinDocumentID, bound.BlockMaxDocumentID)
			}
		} else {
			if !known || bound.BlockIndex >= len(termMeta.Blocks) {
				return fmt.Errorf("term %q: block index %d is not in metadata", bound.Term, bound.BlockIndex)
			}
			block := termMeta.Blocks[bound.BlockIndex]
			if block.MinDocumentID > record.MinDocumentID || block.MaxDocumentID < record.MaxDocumentID {
				return fmt.Errorf("term %q: block %d range [%d,%d] does not cover interval [%d,%d]", bound.Term, bound.BlockIndex, block.MinDocumentID, block.MaxDocumentID, record.MinDocumentID, record.MaxDocumentID)
			}
			if bound.BlockMinDocumentID != block.MinDocumentID || bound.BlockMaxDocumentID != block.MaxDocumentID {
				return fmt.Errorf("term %q: recorded block range [%d,%d] does not match metadata [%d,%d]", bound.Term, bound.BlockMinDocumentID, bound.BlockMaxDocumentID, block.MinDocumentID, block.MaxDocumentID)
			}
			if bound.ContributionUpperBound.Cmp(block.MaxContribution) != 0 {
				return fmt.Errorf("term %q: contribution bound %s does not match block %d maximum %s", bound.Term, bound.ContributionUpperBound.RatString(), bound.BlockIndex, block.MaxContribution.RatString())
			}
		}
		sum = addRat(sum, bound.ScoreUpperBound)
	}
	if sum.Cmp(record.ScoreUpperBound) != 0 {
		return fmt.Errorf("term bounds sum to %s, but total bound is %s", sum.RatString(), record.ScoreUpperBound.RatString())
	}

	cmp := record.ScoreUpperBound.Cmp(record.KthScore)
	switch {
	case cmp < 0:
		if record.Reason != SkipReasonBelowThreshold {
			return fmt.Errorf("bound is below kth score but reason is %q", record.Reason)
		}
	case cmp == 0:
		if record.MinDocumentID < record.KthDocumentID {
			return fmt.Errorf("bound equals kth score and interval minimum ID %d can beat kth ID %d on ties", record.MinDocumentID, record.KthDocumentID)
		}
		if record.Reason != SkipReasonEqualThresholdNoBetterID {
			return fmt.Errorf("bound equals kth score but reason is %q", record.Reason)
		}
	default:
		return fmt.Errorf("score upper bound %s exceeds kth score %s", record.ScoreUpperBound.RatString(), record.KthScore.RatString())
	}

	return nil
}

// VerifySkipRecordWithTerms checks the metadata proof and that the receipt
// names exactly the query terms with their exact weights.
func VerifySkipRecordWithTerms(metadata *IndexMetadata, record SkipRecord, queryWeights map[string]*big.Rat) error {
	if err := VerifySkipRecord(metadata, record); err != nil {
		return err
	}
	if len(queryWeights) != len(record.TermBounds) {
		return fmt.Errorf("receipt has %d term bounds for %d query terms", len(record.TermBounds), len(queryWeights))
	}
	seen := make(map[string]struct{}, len(record.TermBounds))
	for _, bound := range record.TermBounds {
		weight, ok := queryWeights[bound.Term]
		if !ok {
			return fmt.Errorf("receipt contains non-query term %q", bound.Term)
		}
		if err := validateNonNegativeRat(fmt.Sprintf("query weight for term %q", bound.Term), weight); err != nil {
			return err
		}
		if weight.Cmp(bound.Weight) != 0 {
			return fmt.Errorf("term %q: receipt weight %s does not match query weight %s", bound.Term, bound.Weight.RatString(), weight.RatString())
		}
		seen[bound.Term] = struct{}{}
	}
	for term := range queryWeights {
		if _, ok := seen[term]; !ok {
			return fmt.Errorf("query term %q is missing from receipt", term)
		}
	}
	return nil
}

func blocksIntersect(block BlockMetadata, minID, maxID uint64) bool {
	return block.MaxDocumentID >= minID && block.MinDocumentID <= maxID
}

func containsDocument(documents []uint64, id uint64) bool {
	index := sort.Search(len(documents), func(i int) bool {
		return documents[i] >= id
	})
	return index < len(documents) && documents[index] == id
}

func firstDocumentAtLeast(documents []uint64, id uint64) int {
	return sort.Search(len(documents), func(i int) bool {
		return documents[i] >= id
	})
}
