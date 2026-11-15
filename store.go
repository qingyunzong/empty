package dataeng

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// PageRecord is the durable revision state for one canonical page URL. Only
// records that were successfully published are normally marked Confirmed.
type PageRecord struct {
	URL         string
	Fingerprint string
	Revision    int64
	LastMod     time.Time
	Confirmed   bool
	FirstSeen   time.Time
	ConfirmedAt time.Time
	UpdatedAt   time.Time
}

// StateStore persists page revision state. Implementations must key records by
// the canonical URL and should make Get/Put safe for concurrent use.
type StateStore interface {
	Get(ctx context.Context, url string) (PageRecord, bool, error)
	Put(ctx context.Context, record PageRecord) error
}

// RevisionStore is an alias for StateStore.
type RevisionStore = StateStore

// MemoryStore is an in-memory StateStore suitable for tests and single-process
// schedulers.
type MemoryStore struct {
	mu    sync.RWMutex
	pages map[string]PageRecord
}

// NewMemoryStore returns an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{pages: make(map[string]PageRecord)}
}

// Get implements StateStore.
func (s *MemoryStore) Get(ctx context.Context, url string) (PageRecord, bool, error) {
	if err := contextErr(ctx); err != nil {
		return PageRecord{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.pages[url]
	return record, ok, nil
}

// Put implements StateStore.
func (s *MemoryStore) Put(ctx context.Context, record PageRecord) error {
	if err := contextErr(ctx); err != nil {
		return err
	}
	if record.URL == "" {
		return fmt.Errorf("sitemap: state record without URL")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pages == nil {
		s.pages = make(map[string]PageRecord)
	}
	s.pages[record.URL] = record
	return nil
}

// Delete removes a record. It is primarily useful for operational repairs.
func (s *MemoryStore) Delete(url string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pages, url)
}

// Len returns the number of stored records.
func (s *MemoryStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.pages)
}

// Snapshot returns a copy of all records.
func (s *MemoryStore) Snapshot() map[string]PageRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]PageRecord, len(s.pages))
	for url, record := range s.pages {
		out[url] = record
	}
	return out
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}
