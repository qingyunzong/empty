package pagestore

import (
	"errors"
	"sync"
)

// Backend is the durable write adapter. Commit writes new pages first,
// then the new root pointer; the root write is what makes a version
// durable.
type Backend interface {
	WritePages(pages map[PageID][]byte) error
	WriteRoot(version uint64) error
}

// MemBackend is an in-memory Backend recording everything written.
type MemBackend struct {
	mu    sync.Mutex
	Pages map[PageID][]byte
	Roots []uint64
}

// NewMemBackend returns an empty in-memory backend.
func NewMemBackend() *MemBackend {
	return &MemBackend{Pages: map[PageID][]byte{}}
}

// WritePages records pages durably.
func (m *MemBackend) WritePages(pages map[PageID][]byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, val := range pages {
		m.Pages[id] = val
	}
	return nil
}

// WriteRoot records a new durable root version.
func (m *MemBackend) WriteRoot(version uint64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Roots = append(m.Roots, version)
	return nil
}

// ErrInjected is returned by FailBackend when a failure is injected.
var ErrInjected = errors.New("pagestore: injected backend failure")

// FailBackend wraps a MemBackend and fails the next FailWritePages page
// writes and the next FailWriteRoot root writes with ErrInjected.
type FailBackend struct {
	Inner          *MemBackend
	FailWritePages int
	FailWriteRoot  int
}

// WritePages fails while FailWritePages > 0, then delegates.
func (f *FailBackend) WritePages(pages map[PageID][]byte) error {
	if f.FailWritePages > 0 {
		f.FailWritePages--
		return ErrInjected
	}
	return f.Inner.WritePages(pages)
}

// WriteRoot fails while FailWriteRoot > 0, then delegates.
func (f *FailBackend) WriteRoot(version uint64) error {
	if f.FailWriteRoot > 0 {
		f.FailWriteRoot--
		return ErrInjected
	}
	return f.Inner.WriteRoot(version)
}
