// Package model is a reference implementation of forkable page snapshots
// using naive deep copies. It exists to validate the copy-on-write store
// in package pagesnap: any sequence of operations applied to both must
// yield identical reads.
package model

import (
	"errors"
	"sort"

	"pagesnap"
)

// ErrClosed mirrors pagesnap.ErrClosed for closed-snapshot operations.
var ErrClosed = errors.New("model: snapshot is closed")

type snapshot struct {
	pages  map[uint64][pagesnap.PageSize]byte
	closed bool
}

// Model tracks independent snapshots, each owning a full private copy of
// its pages. Correct but memory-hungry: the anti-thesis of copy-on-write.
type Model struct {
	snaps map[uint64]*snapshot
	next  uint64
}

// New returns an empty model.
func New() *Model {
	return &Model{snaps: make(map[uint64]*snapshot)}
}

// NewSnapshot creates an empty root snapshot and returns its ID.
func (m *Model) NewSnapshot() uint64 {
	m.next++
	m.snaps[m.next] = &snapshot{pages: make(map[uint64][pagesnap.PageSize]byte)}
	return m.next
}

// Fork deep-copies the snapshot src into a new snapshot.
func (m *Model) Fork(src uint64) (uint64, error) {
	s, ok := m.snaps[src]
	if !ok || s.closed {
		return 0, ErrClosed
	}
	m.next++
	child := &snapshot{pages: make(map[uint64][pagesnap.PageSize]byte, len(s.pages))}
	for logical, data := range s.pages {
		child.pages[logical] = data
	}
	m.snaps[m.next] = child
	return m.next, nil
}

// Write stores data at the start of the given page, preserving the rest.
func (m *Model) Write(id, logical uint64, data []byte) error {
	s, ok := m.snaps[id]
	if !ok || s.closed {
		return ErrClosed
	}
	page := s.pages[logical]
	copy(page[:], data)
	s.pages[logical] = page
	return nil
}

// Read returns a copy of the given page (zeros if never written).
func (m *Model) Read(id, logical uint64) ([]byte, error) {
	s, ok := m.snaps[id]
	if !ok || s.closed {
		return nil, ErrClosed
	}
	out := make([]byte, pagesnap.PageSize)
	if page, ok := s.pages[logical]; ok {
		copy(out, page[:])
	}
	return out, nil
}

// Close discards the snapshot.
func (m *Model) Close(id uint64) error {
	s, ok := m.snaps[id]
	if !ok || s.closed {
		return ErrClosed
	}
	s.closed = true
	s.pages = nil
	delete(m.snaps, id)
	return nil
}

// LogicalPages returns the sorted page numbers present in the snapshot.
func (m *Model) LogicalPages(id uint64) ([]uint64, error) {
	s, ok := m.snaps[id]
	if !ok || s.closed {
		return nil, ErrClosed
	}
	out := make([]uint64, 0, len(s.pages))
	for logical := range s.pages {
		out = append(out, logical)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}
