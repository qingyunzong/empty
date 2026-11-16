package delivery

import (
	"context"
	"sort"
	"sync"
)

// Store persists delivery records. Implementations must be safe for concurrent
// use. Records are keyed by delivery-tag and retained after settlement so that
// redeliveries of finished work can be recognized; ListUnsettled returns only
// records whose Settled flag is false.
type Store interface {
	// Put inserts a new record. It returns ErrAlreadyExists when the tag is
	// already present, which is what makes duplicate transfers idempotent.
	Put(ctx context.Context, rec Record) error
	// Get returns the record for a tag or ErrNotFound.
	Get(ctx context.Context, tag Tag) (Record, error)
	// Update replaces the stored record. It returns ErrNotFound if absent.
	Update(ctx context.Context, rec Record) error
	// Delete removes the record for a tag. It returns ErrNotFound if absent.
	Delete(ctx context.Context, tag Tag) error
	// ListUnsettled returns every record with Settled == false.
	ListUnsettled(ctx context.Context) ([]Record, error)
}

// EpochStore is optionally implemented by stores that persist the link
// generation counter, fencing stale dispositions across process restarts.
type EpochStore interface {
	// LoadEpoch returns the last persisted epoch, or zero when none exists.
	LoadEpoch(ctx context.Context) (Epoch, error)
	// SaveEpoch persists the current epoch.
	SaveEpoch(ctx context.Context, epoch Epoch) error
}

// MemoryStore is an in-memory Store (and EpochStore), mainly for tests and
// embeddings that provide their own durability. It is safe for concurrent use.
type MemoryStore struct {
	mu      sync.Mutex
	records map[Tag]Record
	epoch   Epoch
}

// NewMemoryStore creates an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[Tag]Record)}
}

// Put implements Store.
func (s *MemoryStore) Put(_ context.Context, rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.records[rec.Tag]; ok {
		return ErrAlreadyExists
	}
	s.records[rec.Tag] = rec
	return nil
}

// Get implements Store.
func (s *MemoryStore) Get(_ context.Context, tag Tag) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.records[tag]
	if !ok {
		return Record{}, ErrNotFound
	}
	return rec, nil
}

// Update implements Store.
func (s *MemoryStore) Update(_ context.Context, rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.records[rec.Tag]; !ok {
		return ErrNotFound
	}
	s.records[rec.Tag] = rec
	return nil
}

// Delete implements Store.
func (s *MemoryStore) Delete(_ context.Context, tag Tag) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.records[tag]; !ok {
		return ErrNotFound
	}
	delete(s.records, tag)
	return nil
}

// ListUnsettled implements Store, ordered by epoch then tag for determinism.
func (s *MemoryStore) ListUnsettled(_ context.Context) ([]Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, 0, len(s.records))
	for _, rec := range s.records {
		if !rec.Settled {
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].LinkEpoch != out[j].LinkEpoch {
			return out[i].LinkEpoch < out[j].LinkEpoch
		}
		return out[i].Tag < out[j].Tag
	})
	return out, nil
}

// LoadEpoch implements EpochStore.
func (s *MemoryStore) LoadEpoch(_ context.Context) (Epoch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.epoch, nil
}

// SaveEpoch implements EpochStore.
func (s *MemoryStore) SaveEpoch(_ context.Context, epoch Epoch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.epoch = epoch
	return nil
}
