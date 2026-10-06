package segidx

import "sort"

// Query matches documents within a segment. Visibility (versions and
// tombstones) is applied by Snapshot.Search on top of segment matches.
type Query interface {
	match(seg *Segment) map[int]struct{}
}

type termQuery struct{ term string }

// Term returns a query matching documents containing the given term.
func Term(term string) Query { return termQuery{NormTerm(term)} }

func (q termQuery) match(seg *Segment) map[int]struct{} {
	out := map[int]struct{}{}
	for _, p := range seg.postings[q.term] {
		out[p.docNum] = struct{}{}
	}
	return out
}

type phraseQuery struct{ terms []string }

// Phrase returns a query matching documents where the given terms occur at
// consecutive positions, in order.
func Phrase(terms ...string) Query {
	norm := make([]string, 0, len(terms))
	for _, t := range terms {
		norm = append(norm, NormTerm(t))
	}
	return phraseQuery{norm}
}

func (q phraseQuery) match(seg *Segment) map[int]struct{} {
	out := map[int]struct{}{}
	if len(q.terms) == 0 {
		return out
	}
	posMaps := make([]map[int][]int, len(q.terms))
	for i, t := range q.terms {
		if t == "" {
			return out
		}
		plist, ok := seg.postings[t]
		if !ok {
			return out
		}
		m := make(map[int][]int, len(plist))
		for _, p := range plist {
			m[p.docNum] = p.positions
		}
		posMaps[i] = m
	}
	for docNum, starts := range posMaps[0] {
		if hasConsecutive(starts, posMaps, docNum) {
			out[docNum] = struct{}{}
		}
	}
	return out
}

// hasConsecutive reports whether some start position s has every term k
// present at position s+k.
func hasConsecutive(starts []int, posMaps []map[int][]int, docNum int) bool {
	for _, s := range starts {
		ok := true
		for k := 1; k < len(posMaps); k++ {
			positions := posMaps[k][docNum]
			i := sort.SearchInts(positions, s+k)
			if i >= len(positions) || positions[i] != s+k {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

type andQuery struct{ qs []Query }

// And returns a query matching documents that match every sub-query.
func And(qs ...Query) Query { return andQuery{qs} }

func (q andQuery) match(seg *Segment) map[int]struct{} {
	if len(q.qs) == 0 {
		return map[int]struct{}{}
	}
	acc := q.qs[0].match(seg)
	for _, sub := range q.qs[1:] {
		m := sub.match(seg)
		for d := range acc {
			if _, ok := m[d]; !ok {
				delete(acc, d)
			}
		}
	}
	return acc
}

type orQuery struct{ qs []Query }

// Or returns a query matching documents that match any sub-query.
func Or(qs ...Query) Query { return orQuery{qs} }

func (q orQuery) match(seg *Segment) map[int]struct{} {
	out := map[int]struct{}{}
	for _, sub := range q.qs {
		for d := range sub.match(seg) {
			out[d] = struct{}{}
		}
	}
	return out
}

type notQuery struct{ q Query }

// Not returns a query matching visible documents that do not match q.
func Not(q Query) Query { return notQuery{q} }

func (q notQuery) match(seg *Segment) map[int]struct{} {
	m := q.q.match(seg)
	out := make(map[int]struct{}, len(seg.docs)-len(m))
	for d := range seg.docs {
		if _, ok := m[d]; !ok {
			out[d] = struct{}{}
		}
	}
	return out
}
