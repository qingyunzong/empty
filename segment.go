package segidx

import "sort"

// posting records one document's occurrences of a term.
type posting struct {
	docNum    int
	positions []int
}

type storedDoc struct {
	id      string
	version uint64
}

// Segment is an immutable inverted index over a batch of documents.
// Once built it is never modified; updates and deletes produce new segments
// or tombstones, and compaction rewrites segments into new ones.
type Segment struct {
	docs     []storedDoc
	byID     map[string][]int
	postings map[string][]posting
	minVer   uint64
	maxVer   uint64
}

type indexDoc struct {
	id      string
	version uint64
	tokens  []string
}

func buildSegment(docs []indexDoc) *Segment {
	seg := &Segment{
		byID:     make(map[string][]int),
		postings: make(map[string][]posting),
	}
	termPos := make(map[string][]int)
	for i, d := range docs {
		docNum := len(seg.docs)
		seg.docs = append(seg.docs, storedDoc{id: d.id, version: d.version})
		seg.byID[d.id] = append(seg.byID[d.id], docNum)
		if i == 0 || d.version < seg.minVer {
			seg.minVer = d.version
		}
		if d.version > seg.maxVer {
			seg.maxVer = d.version
		}
		for term := range termPos {
			delete(termPos, term)
		}
		for pos, tok := range d.tokens {
			termPos[tok] = append(termPos[tok], pos)
		}
		for term, positions := range termPos {
			seg.postings[term] = append(seg.postings[term], posting{docNum: docNum, positions: positions})
		}
	}
	return seg
}

// mergeSegments rewrites the input segments into a single new segment,
// keeping only documents for which keep returns true. The inputs are never
// modified. It returns nil if no document survives.
func mergeSegments(inputs []*Segment, keep func(id string, version uint64) bool) *Segment {
	seg := &Segment{
		byID:     make(map[string][]int),
		postings: make(map[string][]posting),
	}
	newNum := make([][]int, len(inputs))
	first := true
	for i, in := range inputs {
		newNum[i] = make([]int, len(in.docs))
		for j, d := range in.docs {
			newNum[i][j] = -1
			if keep(d.id, d.version) {
				newNum[i][j] = len(seg.docs)
				seg.docs = append(seg.docs, d)
				seg.byID[d.id] = append(seg.byID[d.id], newNum[i][j])
				if first || d.version < seg.minVer {
					seg.minVer = d.version
				}
				if first || d.version > seg.maxVer {
					seg.maxVer = d.version
				}
				first = false
			}
		}
	}
	if len(seg.docs) == 0 {
		return nil
	}
	termSet := make(map[string]struct{})
	for _, in := range inputs {
		for term := range in.postings {
			termSet[term] = struct{}{}
		}
	}
	terms := make([]string, 0, len(termSet))
	for term := range termSet {
		terms = append(terms, term)
	}
	sort.Strings(terms)
	for _, term := range terms {
		var plist []posting
		for i, in := range inputs {
			for _, p := range in.postings[term] {
				if n := newNum[i][p.docNum]; n >= 0 {
					plist = append(plist, posting{docNum: n, positions: p.positions})
				}
			}
		}
		if len(plist) > 0 {
			seg.postings[term] = plist
		}
	}
	return seg
}
