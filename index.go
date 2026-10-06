// Package segindex implements a small retrieval library built from immutable
// index segments that are merged by document ID. It supports term positions,
// phrase queries (positions must be consecutive), versioned deletes, atomic
// same-ID replacement, point-in-time snapshots, and segment compaction.
package segindex

import (
	"sort"
	"strings"
	"sync"
	"unicode"
)

// Document is a single indexable unit.
type Document struct {
	ID   string
	Text string
}

// tokenize splits text into lowercase alphanumeric terms.
func tokenize(text string) []string {
	fields := strings.FieldsFunc(text, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for i := range fields {
		fields[i] = strings.ToLower(fields[i])
	}
	return fields
}

// posting records every position at which a term occurs in one document version.
type posting struct {
	docID     string
	version   uint64
	positions []int
}

// segment is an immutable inverted index plus the tombstones of one commit.
type segment struct {
	terms   map[string][]posting // term -> postings
	docs    map[string]uint64    // docID -> version added
	deletes map[string]uint64    // docID -> tombstone version
}

// Index is a goroutine-safe collection of immutable segments.
type Index struct {
	mu       sync.RWMutex
	segments []*segment
	version  uint64
}

// NewIndex returns an empty index.
func NewIndex() *Index { return &Index{} }

// commit atomically appends one segment under a single new version.
// Every added doc also carries a tombstone for its own ID, so a Put
// atomically replaces any older version of the same ID.
func (ix *Index) commit(adds []Document, dels []string) {
	seg := &segment{
		terms:   make(map[string][]posting),
		docs:    make(map[string]uint64),
		deletes: make(map[string]uint64),
	}
	ix.mu.Lock()
	ix.version++
	v := ix.version
	for _, d := range adds {
		seg.docs[d.ID] = v
		seg.deletes[d.ID] = v // replace semantics: kill older versions
		positions := make(map[string][]int)
		for pos, tok := range tokenize(d.Text) {
			positions[tok] = append(positions[tok], pos)
		}
		for term, ps := range positions {
			seg.terms[term] = append(seg.terms[term], posting{docID: d.ID, version: v, positions: ps})
		}
	}
	for _, id := range dels {
		seg.deletes[id] = v
	}
	ix.segments = append(ix.segments, seg)
	ix.mu.Unlock()
}

// Put atomically replaces any existing document with the same ID.
func (ix *Index) Put(id, text string) { ix.commit([]Document{{ID: id, Text: text}}, nil) }

// PutAll atomically indexes a batch of documents under one version.
func (ix *Index) PutAll(docs ...Document) { ix.commit(docs, nil) }

// Delete removes documents by ID. Later snapshots no longer see them;
// older snapshots are unaffected.
func (ix *Index) Delete(ids ...string) { ix.commit(nil, ids) }

// Snapshot is a consistent, point-in-time view of the index.
type Snapshot struct {
	version  uint64
	segments []*segment
}

// Snapshot captures the current segments; it is unaffected by later writes
// or compaction.
func (ix *Index) Snapshot() *Snapshot {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	segs := make([]*segment, len(ix.segments))
	copy(segs, ix.segments)
	return &Snapshot{version: ix.version, segments: segs}
}

// deleted reports whether a doc version is killed by any tombstone in view.
// A tombstone kills exactly the doc versions strictly older than itself, so a
// doc added in the same commit as its tombstone (an atomic replace) survives.
func (s *Snapshot) deleted(id string, v uint64) bool {
	for _, seg := range s.segments {
		if tv, ok := seg.deletes[id]; ok && tv > v {
			return true
		}
	}
	return false
}

// visiblePostings returns the latest visible posting per doc ID for a term.
func (s *Snapshot) visiblePostings(term string) map[string]posting {
	out := make(map[string]posting)
	for _, seg := range s.segments {
		for _, p := range seg.terms[term] {
			if p.version > s.version || s.deleted(p.docID, p.version) {
				continue
			}
			if cur, ok := out[p.docID]; !ok || p.version > cur.version {
				out[p.docID] = p
			}
		}
	}
	return out
}

func sortedIDs(m map[string]posting) []string {
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Term returns the sorted IDs of documents containing the term.
func (s *Snapshot) Term(term string) []string {
	return sortedIDs(s.visiblePostings(strings.ToLower(term)))
}

// Phrase returns the sorted IDs of documents where the terms occur at
// consecutive positions, in order.
func (s *Snapshot) Phrase(terms ...string) []string {
	if len(terms) == 0 {
		return nil
	}
	norm := make([]string, len(terms))
	for i, t := range terms {
		norm[i] = strings.ToLower(t)
	}
	maps := make([]map[string]posting, len(norm))
	for i, t := range norm {
		maps[i] = s.visiblePostings(t)
	}
	var hits []string
	for id, p0 := range maps[0] {
		sets := make([]map[int]bool, len(norm))
		sets[0] = make(map[int]bool, len(p0.positions))
		for _, p := range p0.positions {
			sets[0][p] = true
		}
		ok := true
		for i := 1; i < len(norm); i++ {
			p, exists := maps[i][id]
			if !exists {
				ok = false
				break
			}
			sets[i] = make(map[int]bool, len(p.positions))
			for _, pos := range p.positions {
				sets[i][pos] = true
			}
		}
		if !ok {
			continue
		}
		for start := range sets[0] {
			match := true
			for i := 1; i < len(norm); i++ {
				if !sets[i][start+i] {
					match = false
					break
				}
			}
			if match {
				hits = append(hits, id)
				break
			}
		}
	}
	sort.Strings(hits)
	return hits
}

// Compact merges all segments by document ID into a single segment, keeping
// only the latest live version of each document and dropping tombstones.
// Deleted documents cannot resurrect because the old segments are discarded
// atomically; existing snapshots keep referencing the old immutable segments.
func (ix *Index) Compact() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	latest := make(map[string]uint64)
	tomb := make(map[string]uint64)
	for _, seg := range ix.segments {
		for id, v := range seg.docs {
			if v > latest[id] {
				latest[id] = v
			}
		}
		for id, v := range seg.deletes {
			if v > tomb[id] {
				tomb[id] = v
			}
		}
	}
	merged := &segment{
		terms:   make(map[string][]posting),
		docs:    make(map[string]uint64),
		deletes: make(map[string]uint64),
	}
	for id, v := range latest {
		if tomb[id] > v {
			continue // deleted: dropped for good
		}
		merged.docs[id] = v
	}
	for _, seg := range ix.segments {
		for term, ps := range seg.terms {
			for _, p := range ps {
				if v, live := merged.docs[p.docID]; live && v == p.version {
					merged.terms[term] = append(merged.terms[term], p)
				}
			}
		}
	}
	ix.segments = []*segment{merged}
}
