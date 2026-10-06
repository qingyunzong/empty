package segidx

import (
	"sort"
	"sync"
	"sync/atomic"
)

// Document is a single indexable record. ID identifies the document across
// updates: indexing a document with an existing ID atomically replaces the
// previous version.
type Document struct {
	ID   string
	Text string
}

// indexState is an immutable view of the index: a list of immutable segments
// plus deletion tombstones (document ID -> delete version). Commits swap the
// state pointer atomically, so snapshots are stable and lock-free to read.
type indexState struct {
	segments []*Segment
	tombs    map[string]uint64
}

// Index is a search index built from immutable segments merged by document
// ID. It is safe for concurrent use.
type Index struct {
	mu      sync.Mutex
	state   atomic.Pointer[indexState]
	version uint64
}

func New() *Index {
	ix := &Index{}
	ix.state.Store(&indexState{tombs: map[string]uint64{}})
	return ix
}

// Add indexes the given documents as one commit (one new segment). Documents
// whose ID already exists replace the previous version atomically; the last
// document wins for duplicate IDs within the batch.
func (ix *Index) Add(docs ...Document) {
	if len(docs) == 0 {
		return
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.version++
	v := ix.version
	order := make([]string, 0, len(docs))
	byID := make(map[string]Document, len(docs))
	for _, d := range docs {
		if _, ok := byID[d.ID]; !ok {
			order = append(order, d.ID)
		}
		byID[d.ID] = d
	}
	batch := make([]indexDoc, 0, len(order))
	for _, id := range order {
		batch = append(batch, indexDoc{id: id, version: v, tokens: Tokenize(byID[id].Text)})
	}
	seg := buildSegment(batch)
	st := ix.state.Load()
	segments := make([]*Segment, 0, len(st.segments)+1)
	segments = append(segments, st.segments...)
	segments = append(segments, seg)
	ix.state.Store(&indexState{segments: segments, tombs: st.tombs})
}

// Delete removes the given document IDs as one commit. A delete shadows every
// version written before it; re-adding the ID afterwards works as expected.
func (ix *Index) Delete(ids ...string) {
	if len(ids) == 0 {
		return
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.version++
	v := ix.version
	st := ix.state.Load()
	tombs := make(map[string]uint64, len(st.tombs)+len(ids))
	for id, tv := range st.tombs {
		tombs[id] = tv
	}
	for _, id := range ids {
		tombs[id] = v
	}
	ix.state.Store(&indexState{segments: st.segments, tombs: tombs})
}

// NumSegments reports the current number of live segments.
func (ix *Index) NumSegments() int { return len(ix.state.Load().segments) }

// Snapshot returns a stable, read-only view of the index. Old snapshots keep
// seeing the documents that were visible when they were taken, regardless of
// later updates, deletes, or compactions.
func (ix *Index) Snapshot() *Snapshot { return &Snapshot{st: ix.state.Load()} }

// Compact merges all segments into one, physically removing shadowed and
// deleted documents, and drops all tombstones. Deletions never resurrect
// because no older segment survives a full compaction.
func (ix *Index) Compact() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	ix.mergeFirstLocked(len(ix.state.Load().segments))
}

// MergeOldest merges the n oldest segments into one. Tombstones that could
// still shadow documents in the remaining (unmerged) segments are retained.
func (ix *Index) MergeOldest(n int) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if total := len(ix.state.Load().segments); n > total {
		n = total
	}
	ix.mergeFirstLocked(n)
}

func (ix *Index) mergeFirstLocked(n int) {
	st := ix.state.Load()
	if n <= 0 || len(st.segments) == 0 {
		return
	}
	head := st.segments[:n]
	tail := st.segments[n:]
	merged := mergeSegments(head, mergeKeep(head, st.tombs))
	tombs := make(map[string]uint64, len(st.tombs))
	for id, tv := range st.tombs {
		if mayAffect(tv, tail) {
			tombs[id] = tv
		}
	}
	segments := make([]*Segment, 0, len(tail)+1)
	if merged != nil {
		segments = append(segments, merged)
	}
	segments = append(segments, tail...)
	ix.state.Store(&indexState{segments: segments, tombs: tombs})
}

// mergeKeep resolves the merge set by document ID: within the set, only the
// newest version of each ID survives, and only if no tombstone covers it.
func mergeKeep(segs []*Segment, tombs map[string]uint64) func(string, uint64) bool {
	maxV := make(map[string]uint64)
	for _, s := range segs {
		for _, d := range s.docs {
			if d.version > maxV[d.id] {
				maxV[d.id] = d.version
			}
		}
	}
	return func(id string, v uint64) bool {
		return v == maxV[id] && v > tombs[id]
	}
}

// mayAffect reports whether a tombstone with version tv could still shadow a
// document living in one of the given (unmerged) segments.
func mayAffect(tv uint64, segs []*Segment) bool {
	for _, s := range segs {
		if s.minVer <= tv {
			return true
		}
	}
	return false
}

// Snapshot is a stable read view of the index at one point in time.
type Snapshot struct {
	st *indexState
}

// Search returns the sorted IDs of the visible documents matching q.
func (s *Snapshot) Search(q Query) []string {
	visible := s.visibleVersions()
	seen := make(map[string]struct{})
	for _, seg := range s.st.segments {
		for docNum := range q.match(seg) {
			d := seg.docs[docNum]
			if visible[d.id] == d.version {
				seen[d.id] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// visibleVersions resolves every document ID to its newest visible version.
// A document version is visible iff it is the newest version of its ID and no
// tombstone covers it.
func (s *Snapshot) visibleVersions() map[string]uint64 {
	maxV := make(map[string]uint64)
	for _, seg := range s.st.segments {
		for _, d := range seg.docs {
			if d.version > maxV[d.id] {
				maxV[d.id] = d.version
			}
		}
	}
	for id, tv := range s.st.tombs {
		if maxV[id] <= tv {
			delete(maxV, id)
		}
	}
	return maxV
}
