package pagestore

import (
	"errors"
	"sync"
)

// Backend is the durable page device underneath the store.
type Backend interface {
	ReadPage(id PageID) ([]byte, error)
	WritePage(id PageID, data []byte) error
	Sync() error
}

// MemBackend is an in-memory Backend used as the base device.
type MemBackend struct {
	mu    sync.Mutex
	pages map[PageID][]byte
}

func NewMemBackend() *MemBackend {
	return &MemBackend{pages: make(map[PageID][]byte)}
}

func (m *MemBackend) ReadPage(id PageID) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.pages[id]
	if !ok {
		return nil, errors.New("pagestore: read of unwritten page")
	}
	out := make([]byte, len(data))
	copy(out, data)
	return out, nil
}

func (m *MemBackend) WritePage(id PageID, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	buf := make([]byte, len(data))
	copy(buf, data)
	m.pages[id] = buf
	return nil
}

func (m *MemBackend) Sync() error { return nil }

// FailBackend wraps a Backend and injects controllable failures:
// the FailAt-th write (1-based) fails with Err, and Sync fails while
// SyncErr is non-nil. Writes are counted so tests can aim precisely.
type FailBackend struct {
	Inner   Backend
	FailAt  int
	Err     error
	SyncErr error

	mu     sync.Mutex
	writes int
}

func (f *FailBackend) WritePage(id PageID, data []byte) error {
	f.mu.Lock()
	f.writes++
	n := f.writes
	failAt, err := f.FailAt, f.Err
	f.mu.Unlock()
	if failAt > 0 && n == failAt {
		if err == nil {
			err = errors.New("pagestore: injected write failure")
		}
		return err
	}
	return f.Inner.WritePage(id, data)
}

func (f *FailBackend) ReadPage(id PageID) ([]byte, error) { return f.Inner.ReadPage(id) }

func (f *FailBackend) Sync() error {
	f.mu.Lock()
	err := f.SyncErr
	f.mu.Unlock()
	if err != nil {
		return err
	}
	return f.Inner.Sync()
}

// Writes reports how many WritePage calls have been attempted.
func (f *FailBackend) Writes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes
}

// Reset clears the write counter and any armed failure.
func (f *FailBackend) Reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = 0
	f.FailAt = 0
	f.SyncErr = nil
}
