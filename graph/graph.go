// Package graph implements an in-memory graph store with snapshot-isolated,
// cursor-based pagination over edges sorted by edge ID.
//
// A cursor pins a snapshot version plus the last edge ID seen. Deletes and
// inserts that happen after a cursor is created never change that cursor's
// read set. Snapshots are retained for a bounded number of versions; a cursor
// that references an evicted snapshot fails with ErrCursorExpired.
package graph

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Edge is a directed edge between two vertices.
type Edge struct {
	ID    uint64
	From  string
	To    string
	Label string
}

// Page is one page of a paginated listing.
type Page struct {
	Edges []Edge
	// NextCursor is empty when the listing is exhausted.
	NextCursor string
}

var (
	// ErrCursorExpired is returned when the cursor's snapshot version is no
	// longer retained by the store.
	ErrCursorExpired = errors.New("graph: cursor expired: snapshot version no longer retained")
	// ErrInvalidCursor is returned for malformed cursors.
	ErrInvalidCursor = errors.New("graph: invalid cursor")
	// ErrEdgeNotFound is returned when removing an unknown edge ID.
	ErrEdgeNotFound = errors.New("graph: edge not found")
)

// snapshot is an immutable, fully consistent view of the graph at one
// version: sorted edge IDs plus bidirectional (out/in) indexes.
type snapshot struct {
	version uint64
	ids     []uint64            // all edge IDs, ascending
	edges   map[uint64]Edge     // ID -> edge
	out     map[string][]uint64 // vertex -> outgoing edge IDs, ascending
	in      map[string][]uint64 // vertex -> incoming edge IDs, ascending
}

func newSnapshot(version uint64) *snapshot {
	return &snapshot{
		version: version,
		edges:   make(map[uint64]Edge),
		out:     make(map[string][]uint64),
		in:      make(map[string][]uint64),
	}
}

// clone deep-copies the snapshot so the original stays immutable.
func (s *snapshot) clone(version uint64) *snapshot {
	c := &snapshot{
		version: version,
		ids:     make([]uint64, len(s.ids)),
		edges:   make(map[uint64]Edge, len(s.edges)),
		out:     make(map[string][]uint64, len(s.out)),
		in:      make(map[string][]uint64, len(s.in)),
	}
	copy(c.ids, s.ids)
	for id, e := range s.edges {
		c.edges[id] = e
	}
	for v, ids := range s.out {
		c.out[v] = append([]uint64(nil), ids...)
	}
	for v, ids := range s.in {
		c.in[v] = append([]uint64(nil), ids...)
	}
	return c
}

// Store is a versioned graph store. All mutations are atomic: a single
// commit updates the edge set and both directional indexes together, and
// readers always observe a consistent snapshot.
type Store struct {
	mu      sync.RWMutex
	nextID  uint64
	version uint64
	retain  int // number of versions (including current) to retain
	cur     *snapshot
	snaps   map[uint64]*snapshot
}

// NewStore creates a store that retains the last retain versions.
// retain must be >= 1.
func NewStore(retain int) *Store {
	if retain < 1 {
		retain = 1
	}
	s0 := newSnapshot(0)
	return &Store{
		version: 0,
		retain:  retain,
		cur:     s0,
		snaps:   map[uint64]*snapshot{0: s0},
	}
}

// commit swaps in a new snapshot and evicts versions beyond retention.
// Callers must hold s.mu.
func (s *Store) commit(next *snapshot) {
	s.cur = next
	s.version = next.version
	s.snaps[next.version] = next
	// Keep versions in [version-retain+1, version]; evict anything older.
	if next.version+1 > uint64(s.retain) {
		lowWater := next.version + 1 - uint64(s.retain)
		for v := range s.snaps {
			if v < lowWater {
				delete(s.snaps, v)
			}
		}
	}
}

// AddEdge inserts an edge and atomically publishes it in the edge set and
// both the out- and in-indexes. It returns the new edge with its ID.
func (s *Store) AddEdge(from, to, label string) Edge {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nextID++
	e := Edge{ID: s.nextID, From: from, To: to, Label: label}

	next := s.cur.clone(s.version + 1)
	next.edges[e.ID] = e
	next.ids = insertSorted(next.ids, e.ID)
	next.out[from] = insertSorted(next.out[from], e.ID)
	next.in[to] = insertSorted(next.in[to], e.ID)

	s.commit(next)
	return e
}

// RemoveEdge deletes an edge and atomically removes it from the edge set and
// both directional indexes.
func (s *Store) RemoveEdge(id uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.cur.edges[id]
	if !ok {
		return ErrEdgeNotFound
	}

	next := s.cur.clone(s.version + 1)
	delete(next.edges, id)
	next.ids = removeSorted(next.ids, id)
	next.out[e.From] = removeSorted(next.out[e.From], id)
	next.in[e.To] = removeSorted(next.in[e.To], id)

	s.commit(next)
	return nil
}

// Version returns the current snapshot version.
func (s *Store) Version() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.version
}

// encodeCursor builds an opaque cursor string.
func encodeCursor(version, lastID uint64) string {
	return fmt.Sprintf("v%d:%d", version, lastID)
}

// decodeCursor parses a cursor produced by encodeCursor.
func decodeCursor(c string) (version, lastID uint64, err error) {
	if !strings.HasPrefix(c, "v") {
		return 0, 0, ErrInvalidCursor
	}
	parts := strings.SplitN(c[1:], ":", 2)
	if len(parts) != 2 {
		return 0, 0, ErrInvalidCursor
	}
	version, err = strconv.ParseUint(parts[0], 10, 64)
	if err != nil {
		return 0, 0, ErrInvalidCursor
	}
	lastID, err = strconv.ParseUint(parts[1], 10, 64)
	if err != nil {
		return 0, 0, ErrInvalidCursor
	}
	return version, lastID, nil
}

// resolve returns the snapshot for a cursor. An empty cursor pins the
// current version.
func (s *Store) resolve(cursor string) (*snapshot, uint64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if cursor == "" {
		return s.cur, 0, nil
	}
	version, lastID, err := decodeCursor(cursor)
	if err != nil {
		return nil, 0, err
	}
	snap, ok := s.snaps[version]
	if !ok {
		return nil, 0, ErrCursorExpired
	}
	return snap, lastID, nil
}

// pageFrom returns up to limit edges from ids with ID > lastID, in ascending
// ID order, plus the next cursor (empty when exhausted).
func (s *Store) pageFrom(snap *snapshot, ids []uint64, lastID uint64, limit int) Page {
	start := sort.Search(len(ids), func(i int) bool { return ids[i] > lastID })
	end := start + limit
	if end > len(ids) {
		end = len(ids)
	}
	page := Page{Edges: make([]Edge, 0, end-start)}
	for _, id := range ids[start:end] {
		page.Edges = append(page.Edges, snap.edges[id])
	}
	if end < len(ids) && len(page.Edges) > 0 {
		page.NextCursor = encodeCursor(snap.version, page.Edges[len(page.Edges)-1].ID)
	}
	return page
}

// ListEdges returns up to limit edges in ascending edge-ID order, starting
// after the edge recorded in cursor. An empty cursor starts a new listing
// pinned to the current snapshot version. The returned NextCursor keeps
// reading from that same pinned snapshot, so concurrent inserts and deletes
// never change the listing's read set.
func (s *Store) ListEdges(cursor string, limit int) (Page, error) {
	if limit <= 0 {
		return Page{}, nil
	}
	snap, lastID, err := s.resolve(cursor)
	if err != nil {
		return Page{}, err
	}
	return s.pageFrom(snap, snap.ids, lastID, limit), nil
}

// ListOutEdges paginates outgoing edges of vertex, ascending by edge ID,
// with the same snapshot-pinned cursor semantics as ListEdges.
func (s *Store) ListOutEdges(vertex, cursor string, limit int) (Page, error) {
	if limit <= 0 {
		return Page{}, nil
	}
	snap, lastID, err := s.resolve(cursor)
	if err != nil {
		return Page{}, err
	}
	return s.pageFrom(snap, snap.out[vertex], lastID, limit), nil
}

// ListInEdges paginates incoming edges of vertex, ascending by edge ID,
// with the same snapshot-pinned cursor semantics as ListEdges.
func (s *Store) ListInEdges(vertex, cursor string, limit int) (Page, error) {
	if limit <= 0 {
		return Page{}, nil
	}
	snap, lastID, err := s.resolve(cursor)
	if err != nil {
		return Page{}, err
	}
	return s.pageFrom(snap, snap.in[vertex], lastID, limit), nil
}

// SnapshotEdges returns the full ascending edge list of the given snapshot
// version, for verification and debugging.
func (s *Store) SnapshotEdges(version uint64) ([]Edge, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snap, ok := s.snaps[version]
	if !ok {
		return nil, ErrCursorExpired
	}
	out := make([]Edge, 0, len(snap.ids))
	for _, id := range snap.ids {
		out = append(out, snap.edges[id])
	}
	return out, nil
}

// insertSorted inserts id into an ascending slice, keeping order.
func insertSorted(ids []uint64, id uint64) []uint64 {
	i := sort.Search(len(ids), func(i int) bool { return ids[i] >= id })
	ids = append(ids, 0)
	copy(ids[i+1:], ids[i:])
	ids[i] = id
	return ids
}

// removeSorted removes id from an ascending slice.
func removeSorted(ids []uint64, id uint64) []uint64 {
	i := sort.Search(len(ids), func(i int) bool { return ids[i] >= id })
	if i < len(ids) && ids[i] == id {
		return append(ids[:i], ids[i+1:]...)
	}
	return ids
}
