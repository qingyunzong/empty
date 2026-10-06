// Package gallery implements a versioned edge store with stable cursor
// pagination, snapshot isolation for in-flight cursors, and an atomically
// maintained bidirectional edge index.
package gallery

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// ErrCursorExpired is returned when a cursor references a snapshot version
// that the store no longer retains.
var ErrCursorExpired = errors.New("gallery: cursor expired: snapshot version no longer retained")

// Edge is a directed edge between two nodes.
type Edge struct {
	ID     uint64
	Source string
	Target string
}

// Cursor pins a pagination position to an immutable snapshot version.
// A cursor remains valid as long as its version is retained by the store,
// regardless of concurrent inserts or deletes.
type Cursor struct {
	Version uint64
	LastID  uint64 // last edge ID returned; 0 means "from the beginning"
}

// Direction selects which side of the bidirectional index to query.
type Direction int

const (
	Out Direction = iota // edges whose Source is the node
	In                   // edges whose Target is the node
)

// Store is a concurrency-safe, versioned edge store.
//
// Every mutation commits a new version holding an immutable, ID-sorted
// snapshot of all edges. The store retains the most recent `retain`
// versions; cursors pointing at evicted versions fail with ErrCursorExpired.
type Store struct {
	mu       sync.RWMutex
	edges    map[uint64]Edge
	outIndex map[string]map[uint64]struct{} // source -> edge IDs
	inIndex  map[string]map[uint64]struct{} // target -> edge IDs
	nextID   uint64
	version  uint64
	retain   int
	snaps    map[uint64][]Edge // version -> immutable ID-sorted snapshot
	versions []uint64          // retained versions, ascending
}

// NewStore creates a store retaining the last `retain` snapshot versions.
// retain must be >= 1.
func NewStore(retain int) *Store {
	if retain < 1 {
		panic("gallery: retain must be >= 1")
	}
	s := &Store{
		edges:    make(map[uint64]Edge),
		outIndex: make(map[string]map[uint64]struct{}),
		inIndex:  make(map[string]map[uint64]struct{}),
		nextID:   1,
		retain:   retain,
		snaps:    make(map[uint64][]Edge),
	}
	s.commitLocked()
	return s
}

// AddEdge inserts an edge and returns its assigned ID. The bidirectional
// index and the new snapshot version are committed atomically with the
// insert.
func (s *Store) AddEdge(source, target string) Edge {
	s.mu.Lock()
	defer s.mu.Unlock()

	e := Edge{ID: s.nextID, Source: source, Target: target}
	s.nextID++
	s.edges[e.ID] = e
	addToIndex(s.outIndex, source, e.ID)
	addToIndex(s.inIndex, target, e.ID)
	s.commitLocked()
	return e
}

// RemoveEdge deletes an edge by ID. It reports whether the edge existed.
// The bidirectional index and the new snapshot version are committed
// atomically with the delete.
func (s *Store) RemoveEdge(id uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.edges[id]
	if !ok {
		return false
	}
	delete(s.edges, id)
	removeFromIndex(s.outIndex, e.Source, id)
	removeFromIndex(s.inIndex, e.Target, id)
	s.commitLocked()
	return true
}

// Version returns the current snapshot version.
func (s *Store) Version() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.version
}

// Begin returns a cursor pinned to the current snapshot version, positioned
// before the first edge.
func (s *Store) Begin() Cursor {
	return Cursor{Version: s.Version()}
}

// Page returns up to `limit` edges with ID greater than cursor.LastID, read
// from the immutable snapshot pinned by cursor.Version, plus the cursor for
// the next page. Deletes and inserts committed after cursor.Version do not
// affect the result. If the pinned version has been evicted, Page returns
// ErrCursorExpired.
func (s *Store) Page(cursor Cursor, limit int) ([]Edge, Cursor, error) {
	if limit < 1 {
		return nil, cursor, fmt.Errorf("gallery: limit must be >= 1, got %d", limit)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	snap, ok := s.snaps[cursor.Version]
	if !ok {
		return nil, cursor, fmt.Errorf("%w (version %d)", ErrCursorExpired, cursor.Version)
	}
	start := sort.Search(len(snap), func(i int) bool { return snap[i].ID > cursor.LastID })
	end := start + limit
	if end > len(snap) {
		end = len(snap)
	}
	page := make([]Edge, end-start)
	copy(page, snap[start:end])

	next := cursor
	if len(page) > 0 {
		next.LastID = page[len(page)-1].ID
	}
	return page, next, nil
}

// List returns the full ID-sorted edge list of the snapshot pinned by
// cursor.Version.
func (s *Store) List(cursor Cursor) ([]Edge, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	snap, ok := s.snaps[cursor.Version]
	if !ok {
		return nil, fmt.Errorf("%w (version %d)", ErrCursorExpired, cursor.Version)
	}
	out := make([]Edge, len(snap))
	copy(out, snap)
	return out, nil
}

// Neighbors returns the IDs of edges adjacent to node in the given
// direction, read from the live bidirectional index, sorted ascending.
func (s *Store) Neighbors(node string, dir Direction) []uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var idx map[string]map[uint64]struct{}
	if dir == Out {
		idx = s.outIndex
	} else {
		idx = s.inIndex
	}
	var ids []uint64
	for id := range idx[node] {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// commitLocked bumps the version, records an immutable snapshot of the
// current edge set, and evicts versions beyond the retention window.
// Callers must hold s.mu (write).
func (s *Store) commitLocked() {
	snap := make([]Edge, 0, len(s.edges))
	for _, e := range s.edges {
		snap = append(snap, e)
	}
	sort.Slice(snap, func(i, j int) bool { return snap[i].ID < snap[j].ID })

	s.version++
	s.snaps[s.version] = snap
	s.versions = append(s.versions, s.version)
	if len(s.versions) > s.retain {
		evict := s.versions[:len(s.versions)-s.retain]
		for _, v := range evict {
			delete(s.snaps, v)
		}
		s.versions = s.versions[len(evict):]
	}
}

func addToIndex(idx map[string]map[uint64]struct{}, node string, id uint64) {
	set, ok := idx[node]
	if !ok {
		set = make(map[uint64]struct{})
		idx[node] = set
	}
	set[id] = struct{}{}
}

func removeFromIndex(idx map[string]map[uint64]struct{}, node string, id uint64) {
	set, ok := idx[node]
	if !ok {
		return
	}
	delete(set, id)
	if len(set) == 0 {
		delete(idx, node)
	}
}
