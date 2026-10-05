package tokenindex

import (
	"fmt"
	"sort"
)

// Threshold is a rational Jaccard threshold Num/Den with
// 0 <= Num <= Den and Den > 0. A document qualifies when
// |Q ∩ D| / |Q ∪ D| >= Num/Den. The empty-empty similarity is defined
// as 1, so it meets every valid threshold.
type Threshold struct {
	Num int64
	Den int64
}

// Valid reports whether the threshold is a well-formed rational in [0,1].
func (t Threshold) Valid() bool {
	return t.Den > 0 && t.Num >= 0 && t.Num <= t.Den
}

// reached reports whether inter/union meets the threshold. union == 0 is
// the empty-empty case whose similarity is defined as 1.
func (t Threshold) reached(inter, union int) bool {
	if union == 0 {
		return true
	}
	return int64(inter)*t.Den >= t.Num*int64(union)
}

// below reports whether inter/union is strictly below the threshold.
func (t Threshold) below(inter, union int) bool {
	return !t.reached(inter, union)
}

// Hit is a confirmed query result: the document's exact intersection and
// union sizes against the query set were computed.
type Hit struct {
	ID    DocID
	Inter int
	Union int
}

// Bound is a verifiable similarity upper-bound certificate for one
// document. The certified similarity upper bound is
//
//	MaxInter / (QueryLen + DocLen - MaxInter)
//
// with the empty-empty case (denominator 0) defined as 1. When Exact is
// true, MaxInter is the exact intersection size; otherwise it is the
// length-only bound min(QueryLen, DocLen).
type Bound struct {
	ID       DocID
	QueryLen int
	DocLen   int
	MaxInter int
	Exact    bool
}

// upperUnion returns the union size implied by the certificate.
func (b Bound) upperUnion() int {
	return b.QueryLen + b.DocLen - b.MaxInter
}

// UpperReached reports whether the certified upper bound still meets the
// threshold (i.e. the document cannot be excluded by this certificate).
func (b Bound) UpperReached(t Threshold) bool {
	return t.reached(b.MaxInter, b.upperUnion())
}

// UpperBelow reports whether the certified upper bound is strictly below
// the threshold, proving the document is not a hit.
func (b Bound) UpperBelow(t Threshold) bool {
	return t.below(b.MaxInter, b.upperUnion())
}

// Result is the outcome of a threshold query.
type Result struct {
	// Hits are documents proven to meet the threshold, sorted by score
	// (Inter/Union, empty-empty treated as 1) descending, then ID.
	Hits []Hit
	// Unclosed are candidate documents that could not be decided within
	// the scan budget; each carries a verifiable upper-bound certificate.
	Unclosed []Bound
	// Pruned are documents excluded without a full scan, each with a
	// verifiable certificate whose upper bound is below the threshold.
	Pruned []Bound
	// Scanned is the number of documents whose exact intersection was
	// computed (the budget unit consumed per document).
	Scanned int
	// Budget is the scan budget the query ran with; negative means
	// unlimited.
	Budget int
	// Exhausted is true when the budget ran out before every candidate
	// could be decided, i.e. len(Unclosed) > 0 because of the budget.
	Exhausted bool
}

// lengthBound builds the length-only certificate min(q,d)/max(q,d).
func lengthBound(id DocID, q, d int) Bound {
	m := q
	if d < m {
		m = d
	}
	return Bound{ID: id, QueryLen: q, DocLen: d, MaxInter: m}
}

// Query returns all documents whose Jaccard similarity to the query token
// set meets the threshold. Duplicate query tokens are counted once.
//
// Candidates are gathered from the inverted index; documents sharing no
// token with the query have an exact intersection of 0 and are decided
// immediately. Remaining candidates are pre-pruned with the length bound
// min(|Q|,|D|)/max(|Q|,|D|), then scanned in decreasing upper-bound order
// until the budget is exhausted. budget < 0 means unlimited. When the
// budget is insufficient the result still contains every definite hit
// found so far plus the unclosed candidates with their certificates.
func (x *Index) Query(tokens []string, th Threshold, budget int) Result {
	if !th.Valid() {
		panic("tokenindex: invalid threshold")
	}
	qset := dedup(tokens)
	q := len(qset)

	x.mu.RLock()
	defer x.mu.RUnlock()

	res := Result{Budget: budget}
	remaining := budget

	// Candidate set: union of posting lists of query tokens.
	cand := make(map[DocID]struct{})
	for t := range qset {
		for id := range x.inv[t] {
			cand[id] = struct{}{}
		}
	}

	// Non-candidates share no token with the query: exact intersection 0.
	for id, d := range x.lens {
		if _, ok := cand[id]; ok {
			continue
		}
		b := Bound{ID: id, QueryLen: q, DocLen: d, MaxInter: 0, Exact: true}
		if th.reached(0, q+d) {
			res.Hits = append(res.Hits, Hit{ID: id, Inter: 0, Union: q + d})
		} else {
			res.Pruned = append(res.Pruned, b)
		}
	}

	// Rank candidates by length bound (desc), then ID, for a
	// deterministic best-first scan order.
	order := make([]DocID, 0, len(cand))
	for id := range cand {
		order = append(order, id)
	}
	sort.Slice(order, func(i, j int) bool {
		bi, bj := lengthBound(order[i], q, x.lens[order[i]]), lengthBound(order[j], q, x.lens[order[j]])
		ci, cj := bi.MaxInter*bj.upperUnion(), bj.MaxInter*bi.upperUnion()
		if ci != cj {
			return ci > cj
		}
		return order[i] < order[j]
	})

	for _, id := range order {
		d := x.lens[id]
		lb := lengthBound(id, q, d)
		if lb.UpperBelow(th) {
			// Length-only pruning: no budget spent.
			res.Pruned = append(res.Pruned, lb)
			continue
		}
		if remaining == 0 {
			res.Exhausted = true
			res.Unclosed = append(res.Unclosed, lb)
			continue
		}
		if remaining > 0 {
			remaining--
		}
		res.Scanned++
		inter := 0
		for t := range x.docs[id] {
			if _, ok := qset[t]; ok {
				inter++
			}
		}
		union := q + d - inter
		if th.reached(inter, union) {
			res.Hits = append(res.Hits, Hit{ID: id, Inter: inter, Union: union})
		} else {
			res.Pruned = append(res.Pruned, Bound{ID: id, QueryLen: q, DocLen: d, MaxInter: inter, Exact: true})
		}
	}

	sortHits(res.Hits)
	sort.Slice(res.Unclosed, func(i, j int) bool { return res.Unclosed[i].ID < res.Unclosed[j].ID })
	sort.Slice(res.Pruned, func(i, j int) bool { return res.Pruned[i].ID < res.Pruned[j].ID })
	return res
}

// sortHits orders hits by score descending (empty-empty counts as 1),
// then by ID ascending.
func sortHits(hits []Hit) {
	scoreLess := func(a, b Hit) bool {
		// returns true if a ranks before b
		an, ad := a.Inter, a.Union
		bn, bd := b.Inter, b.Union
		if ad == 0 {
			an, ad = 1, 1
		}
		if bd == 0 {
			bn, bd = 1, 1
		}
		l, r := an*bd, bn*ad
		if l != r {
			return l > r
		}
		return a.ID < b.ID
	}
	sort.Slice(hits, func(i, j int) bool { return scoreLess(hits[i], hits[j]) })
}

// VerifyBound checks a certificate against the index's current data:
// QueryLen and DocLen must match reality, an Exact certificate's MaxInter
// must equal the true intersection size, and a non-exact certificate must
// use the length-only bound min(QueryLen, DocLen).
func (x *Index) VerifyBound(tokens []string, b Bound) bool {
	qset := dedup(tokens)
	x.mu.RLock()
	defer x.mu.RUnlock()
	set, ok := x.docs[b.ID]
	if !ok {
		return false
	}
	if b.QueryLen != len(qset) || b.DocLen != len(set) {
		return false
	}
	if b.Exact {
		inter := 0
		for t := range set {
			if _, ok := qset[t]; ok {
				inter++
			}
		}
		return b.MaxInter == inter
	}
	m := b.QueryLen
	if b.DocLen < m {
		m = b.DocLen
	}
	return b.MaxInter == m
}

// BruteForce is the independent full-comparison model: it computes the
// exact Jaccard intersection/union of every document against the query
// set directly from the document sets, ignoring the inverted and length
// indexes, and returns the qualifying hits sorted by score then ID.
func (x *Index) BruteForce(tokens []string, th Threshold) []Hit {
	if !th.Valid() {
		panic("tokenindex: invalid threshold")
	}
	qset := dedup(tokens)
	q := len(qset)
	x.mu.RLock()
	defer x.mu.RUnlock()
	var hits []Hit
	for id, set := range x.docs {
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

// Audit independently verifies a query Result against the index:
//
//   - no missed hits: every brute-force hit appears in Hits or Unclosed;
//   - every reported hit truly meets the threshold with exact counts;
//   - every pruned certificate is verifiable and its upper bound is
//     strictly below the threshold;
//   - every unclosed certificate is verifiable and its upper bound still
//     reaches the threshold (otherwise it should have been pruned);
//   - every document is accounted for exactly once across the three sets.
//
// It returns nil when the result is fully consistent.
func (x *Index) Audit(tokens []string, th Threshold, res Result) error {
	seen := make(map[DocID]string, len(res.Hits)+len(res.Unclosed)+len(res.Pruned))
	mark := func(id DocID, where string) error {
		if prev, dup := seen[id]; dup {
			return fmt.Errorf("tokenindex: doc %d appears in both %s and %s", id, prev, where)
		}
		seen[id] = where
		return nil
	}
	for _, h := range res.Hits {
		if err := mark(h.ID, "hits"); err != nil {
			return err
		}
		if !x.VerifyBound(tokens, Bound{ID: h.ID, QueryLen: len(dedup(tokens)), DocLen: h.Union + h.Inter - len(dedup(tokens)), MaxInter: h.Inter, Exact: true}) {
			return fmt.Errorf("tokenindex: hit %d has inconsistent counts", h.ID)
		}
		if !th.reached(h.Inter, h.Union) {
			return fmt.Errorf("tokenindex: hit %d does not meet threshold", h.ID)
		}
	}
	for _, b := range res.Pruned {
		if err := mark(b.ID, "pruned"); err != nil {
			return err
		}
		if !x.VerifyBound(tokens, b) {
			return fmt.Errorf("tokenindex: pruned certificate for doc %d does not verify", b.ID)
		}
		if !b.UpperBelow(th) {
			return fmt.Errorf("tokenindex: pruned certificate for doc %d does not exclude the doc", b.ID)
		}
	}
	for _, b := range res.Unclosed {
		if err := mark(b.ID, "unclosed"); err != nil {
			return err
		}
		if !x.VerifyBound(tokens, b) {
			return fmt.Errorf("tokenindex: unclosed certificate for doc %d does not verify", b.ID)
		}
		if !b.UpperReached(th) {
			return fmt.Errorf("tokenindex: unclosed certificate for doc %d should have been pruned", b.ID)
		}
	}
	for _, id := range x.DocIDs() {
		if _, ok := seen[id]; !ok {
			return fmt.Errorf("tokenindex: doc %d missing from query result", id)
		}
	}
	// No missed hits: every true hit must be decided or unclosed.
	for _, h := range x.BruteForce(tokens, th) {
		where, ok := seen[h.ID]
		if !ok {
			return fmt.Errorf("tokenindex: true hit %d unaccounted for", h.ID)
		}
		if where == "pruned" {
			return fmt.Errorf("tokenindex: true hit %d wrongly pruned", h.ID)
		}
	}
	return nil
}
