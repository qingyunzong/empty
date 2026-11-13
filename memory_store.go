package dataeng

import (
	"context"
	"sync"
)

// MemoryStore is a non-durable CheckpointStore for tests and single-process
// integrations. Production deployments should persist checkpoints atomically.
type MemoryStore struct {
	mu         sync.Mutex
	checkpoint Checkpoint
}

// NewMemoryStore returns an empty in-memory checkpoint store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Load returns a copy of the current checkpoint.
func (s *MemoryStore) Load(ctx context.Context) (Checkpoint, error) {
	if err := ctx.Err(); err != nil {
		return Checkpoint{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkpoint, nil
}

// Save replaces the current checkpoint.
func (s *MemoryStore) Save(ctx context.Context, checkpoint Checkpoint) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.checkpoint = checkpoint
	return nil
}
