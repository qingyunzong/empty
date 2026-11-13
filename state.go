package dataeng

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// Record is the durable per-shard scheduling state.
type Record struct {
	ShardID     ShardID
	Watermark   SequenceNumber
	OutputAck   SequenceNumber
	Completed   bool
	CompletedAt time.Time
	Lease       Lease
	Generation  uint64
	Version     uint64
}

// Checkpoint returns the last processed sequence number.
func (r Record) Checkpoint() SequenceNumber { return r.Watermark }

// Acknowledged returns the last output-confirmed sequence number.
func (r Record) Acknowledged() SequenceNumber { return r.OutputAck }

// Store is the durable state boundary used by Coordinator. Implementations
// must make CompareAndSwap atomic across workers.
//
// CompareAndSwap semantics:
//   - expectedVersion == 0 creates the record only if it does not exist.
//   - expectedVersion > 0 replaces the record only if its current Version is
//     exactly expectedVersion.
//   - On success the stored Version must be expectedVersion+1.
//   - On mismatch implementations must return ErrVersionConflict.
//
// Because each shard's lease, watermark, output acknowledgement, completion
// flag, and generation live in one Record, a successful swap is one atomic
// transition of all of them.
type Store interface {
	Load(ctx context.Context, shard ShardID) (Record, bool, error)
	CompareAndSwap(ctx context.Context, shard ShardID, expectedVersion uint64, next Record) error
}

// MemoryStore is an in-process Store. It is useful for a single collector and
// for tests; a multi-process deployment should implement Store over its
// database.
type MemoryStore struct {
	mu      sync.RWMutex
	records map[ShardID]Record
}

// NewMemoryStore creates an empty in-memory state store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{records: make(map[ShardID]Record)}
}

// NewInMemoryStore is an alias for NewMemoryStore.
func NewInMemoryStore() *MemoryStore { return NewMemoryStore() }

// Load returns a copy of the shard record.
func (s *MemoryStore) Load(ctx context.Context, shard ShardID) (Record, bool, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.records[shard]
	return record, ok, nil
}

// CompareAndSwap atomically applies a version-checked record replacement.
func (s *MemoryStore) CompareAndSwap(
	ctx context.Context,
	shard ShardID,
	expectedVersion uint64,
	next Record,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if next.ShardID == "" {
		next.ShardID = shard
	}
	if next.ShardID != shard {
		return fmt.Errorf("%w: record for %q cannot replace %q",
			ErrInvalidLease, next.ShardID, shard)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.records == nil {
		s.records = make(map[ShardID]Record)
	}
	current, exists := s.records[shard]
	switch {
	case expectedVersion == 0 && exists:
		return fmt.Errorf("%w: shard %q already exists", ErrVersionConflict, shard)
	case expectedVersion > 0 && !exists:
		return fmt.Errorf("%w: shard %q does not exist", ErrVersionConflict, shard)
	case expectedVersion > 0 && current.Version != expectedVersion:
		return fmt.Errorf("%w: shard %q version %d, expected %d",
			ErrVersionConflict, shard, current.Version, expectedVersion)
	}
	next.Version = expectedVersion + 1
	s.records[shard] = next
	return nil
}

// Snapshot returns a copy of all records for diagnostics.
func (s *MemoryStore) Snapshot() map[ShardID]Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[ShardID]Record, len(s.records))
	for id, record := range s.records {
		result[id] = record
	}
	return result
}
