package dualindex

import (
	"sort"
	"strings"
	"sync"
)

// Snapshot is a read-only view of one published generation. Both indexes and
// the raw documents in a Snapshot always come from the same build. A Snapshot
// pins its generation: the generation's files are deleted only after Close.
type Snapshot struct {
	store *Store
	gen   *generation
	once  sync.Once
}

// Acquire returns a Snapshot of the currently published generation.
func (s *Store) Acquire() *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current.refs++
	return &Snapshot{store: s, gen: s.current}
}

// Gen returns the generation number of the snapshot.
func (sn *Snapshot) Gen() int {
	return sn.gen.num
}

// ContentGen returns the generation recorded inside the content index file.
func (sn *Snapshot) ContentGen() int {
	return sn.gen.content.Gen
}

// PathGen returns the generation recorded inside the path index file.
func (sn *Snapshot) PathGen() int {
	return sn.gen.path.Gen
}

// Query returns the sorted paths of all documents containing term.
func (sn *Snapshot) Query(term string) []string {
	paths := sn.gen.content.Terms[strings.ToLower(term)]
	out := make([]string, len(paths))
	copy(out, paths)
	return out
}

// Terms returns all indexed terms in sorted order.
func (sn *Snapshot) Terms() []string {
	terms := make([]string, 0, len(sn.gen.content.Terms))
	for term := range sn.gen.content.Terms {
		terms = append(terms, term)
	}
	sort.Strings(terms)
	return terms
}

// Stat looks up a document in the path index.
func (sn *Snapshot) Stat(path string) (PathEntry, bool) {
	e, ok := sn.gen.path.Paths[path]
	return e, ok
}

// Docs returns the raw document set of this generation. The map is shared
// and must not be modified.
func (sn *Snapshot) Docs() map[string][]byte {
	return sn.gen.docs
}

// Close releases the snapshot. The pinned generation becomes eligible for
// deletion once its last snapshot is closed.
func (sn *Snapshot) Close() {
	sn.once.Do(func() {
		s := sn.store
		s.mu.Lock()
		defer s.mu.Unlock()
		sn.gen.refs--
		s.gcLocked()
	})
}
