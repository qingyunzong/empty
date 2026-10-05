package docset

import "sort"

// Hit is a document whose exact Jaccard score reached the threshold.
type Hit struct {
	DocID string
	Score Rat // exact |intersection|/|union|; empty-empty is 1/1
}

// CertBound is a pruning certificate: a verifiable upper bound on the
// Jaccard similarity between the query and DocID, derived only from
// the two set sizes (min/max). Anyone can re-check it from Len().
type CertBound struct {
	DocID string
	Bound Rat
}

// Result is the outcome of a threshold Query.
type Result struct {
	// Hits are the definite hits, sorted by score descending then ID.
	Hits []Hit
	// Unclosed are candidates whose bound reached the threshold but
	// which were not scanned because the budget ran out. They may or
	// may not be hits; each carries its certified upper bound.
	Unclosed []CertBound
	// Rejected are documents that were scored exactly within budget
	// but fell below the threshold, sorted by ID.
	Rejected []string
	// Pruned lists every document excluded without scanning, each
	// with a certified upper bound strictly below the threshold.
	Pruned []CertBound
	// Complete is true when every candidate was scanned (no unclosed
	// candidates), so Hits is exactly the set of matching documents.
	Complete bool
}

// Query returns every document whose Jaccard similarity with the
// query token set is >= threshold, where the similarity of two empty
// sets is defined as 1. Duplicate query tokens are counted once.
//
// threshold must satisfy 0 <= Num <= Den and Den > 0.
//
// budget caps how many candidate documents are scored exactly;
// a negative budget means unlimited. Documents are first pruned by
// the length-only upper bound min(|Q|,|D|)/max(|Q|,|D|): any document
// whose bound is below the threshold is excluded with a certificate.
// Remaining candidates are scanned in decreasing bound order; if the
// budget is exhausted, the unscanned ones are returned as Unclosed.
func (s *Store) Query(tokens []string, threshold Rat, budget int) Result {
	if threshold.Den <= 0 || threshold.Num < 0 || threshold.Num > threshold.Den {
		panic("docset: threshold outside [0,1]")
	}
	query := dedup(tokens)
	qlen := int64(len(query))

	type candidate struct {
		id    string
		bound Rat
	}
	var cands []candidate
	var pruned []CertBound
	for id, n := range s.lengths {
		bound := lengthBound(qlen, int64(n))
		if bound.cmp(threshold) < 0 {
			pruned = append(pruned, CertBound{DocID: id, Bound: bound})
			continue
		}
		cands = append(cands, candidate{id: id, bound: bound})
	}
	sort.Slice(cands, func(i, j int) bool {
		if c := cands[i].bound.cmp(cands[j].bound); c != 0 {
			return c > 0
		}
		return cands[i].id < cands[j].id
	})
	sort.Slice(pruned, func(i, j int) bool { return pruned[i].DocID < pruned[j].DocID })

	var hits []Hit
	var rejected []string
	var unclosed []CertBound
	scanned := 0
	for _, c := range cands {
		if budget >= 0 && scanned >= budget {
			unclosed = append(unclosed, CertBound{DocID: c.id, Bound: c.bound})
			continue
		}
		scanned++
		inter, union := overlap(query, s.docs[c.id])
		score := jaccardRat(inter, union)
		if score.cmp(threshold) >= 0 {
			hits = append(hits, Hit{DocID: c.id, Score: score})
		} else {
			rejected = append(rejected, c.id)
		}
	}
	sort.Strings(rejected)
	sort.Slice(hits, func(i, j int) bool {
		if c := hits[i].Score.cmp(hits[j].Score); c != 0 {
			return c > 0
		}
		return hits[i].DocID < hits[j].DocID
	})
	return Result{
		Hits:     hits,
		Rejected: rejected,
		Unclosed: unclosed,
		Pruned:   pruned,
		Complete: len(unclosed) == 0,
	}
}

// overlap computes |a ∩ b| and |a ∪ b| iterating over the smaller set.
func overlap(a, b map[string]struct{}) (inter, union int64) {
	small, large := a, b
	if len(small) > len(large) {
		small, large = large, small
	}
	for t := range small {
		if _, ok := large[t]; ok {
			inter++
		}
	}
	return inter, int64(len(a)+len(b)) - inter
}
