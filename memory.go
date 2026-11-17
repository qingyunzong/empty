package formal

import (
	"context"
	"math"
	"sync"
)

// MemoryStore is a concurrency-safe in-memory Store. It is useful for tests
// and for embedding the state machine in a controller that already has an
// atomic key-value backend.
type MemoryStore struct {
	mu      sync.Mutex
	leases  map[LeaseKey]Lease
	version uint64
}

// NewMemoryStore returns an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{leases: make(map[LeaseKey]Lease)}
}

// Get implements Store.
func (s *MemoryStore) Get(ctx context.Context, key LeaseKey) (Lease, bool, error) {
	if err := ctx.Err(); err != nil {
		return Lease{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	lease, ok := s.leases[key]
	return lease, ok, nil
}

// Create implements Store.
func (s *MemoryStore) Create(ctx context.Context, lease Lease) (Lease, error) {
	if err := ctx.Err(); err != nil {
		return Lease{}, err
	}
	if err := lease.Validate(); err != nil {
		return Lease{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.leases[lease.Key()]; ok {
		return Lease{}, ErrResourceVersionConflict
	}
	version, err := s.nextVersionLocked()
	if err != nil {
		return Lease{}, err
	}
	lease.ResourceVersion = version
	s.leases[lease.Key()] = lease
	return lease, nil
}

// Update implements Store.
func (s *MemoryStore) Update(ctx context.Context, lease Lease, expectedResourceVersion uint64) (Lease, error) {
	if err := ctx.Err(); err != nil {
		return Lease{}, err
	}
	if err := lease.Validate(); err != nil {
		return Lease{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.leases[lease.Key()]
	if !ok {
		return Lease{}, ErrLeaseNotFound
	}
	if current.ResourceVersion != expectedResourceVersion {
		return Lease{}, ErrResourceVersionConflict
	}
	version, err := s.nextVersionLocked()
	if err != nil {
		return Lease{}, err
	}
	lease.ResourceVersion = version
	s.leases[lease.Key()] = lease
	return lease, nil
}

func (s *MemoryStore) nextVersionLocked() (uint64, error) {
	if s.version == math.MaxUint64 {
		return 0, ErrResourceVersionOverflow
	}
	s.version++
	return s.version, nil
}
