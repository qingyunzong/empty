package readwait

import (
	"context"
	"fmt"
	"sync"
)

// Entry is a single committed key/value mutation.
type Entry struct {
	Key   string
	Value string
}

// Store is a replica key/value store whose reads are linearizable with
// respect to a target commit index: Read blocks until the replica has
// applied at least that index, and fails loudly (ErrNotReached) on timeout
// instead of serving a stale value.
type Store struct {
	mu       sync.RWMutex
	data     map[string]string
	notifier *Notifier
}

func NewStore() *Store {
	return &Store{data: make(map[string]string), notifier: NewNotifier()}
}

// Applied returns the replica's applied index.
func (s *Store) Applied() uint64 {
	return s.notifier.Applied()
}

// Waiters returns the number of pending read waiters.
func (s *Store) Waiters() int {
	return s.notifier.Waiters()
}

// Apply commits entries at the given log index and wakes satisfied readers.
// Applying an index at or below the current applied index is a no-op for
// the barrier (entries are still written idempotently by key).
func (s *Store) Apply(index uint64, entries ...Entry) {
	s.mu.Lock()
	for _, e := range entries {
		s.data[e.Key] = e.Value
	}
	s.mu.Unlock()
	s.notifier.applyTo(index)
}

// InstallSnapshot replaces the store contents with the snapshot taken at the
// given index. The applied index never regresses: if the replica has already
// applied beyond the snapshot index, the barrier stays at the higher index.
func (s *Store) InstallSnapshot(index uint64, data map[string]string) {
	s.mu.Lock()
	s.data = make(map[string]string, len(data))
	for k, v := range data {
		s.data[k] = v
	}
	s.mu.Unlock()
	s.notifier.applyTo(index)
}

// Read returns the value for key, but only after the replica has applied up
// to target. The target is registered before waiting so a concurrent apply
// cannot be missed. If ctx expires first, the waiter is removed and
// ErrNotReached is returned — never a stale value.
func (s *Store) Read(ctx context.Context, target uint64, key string) (string, error) {
	if err := s.notifier.Wait(ctx, target); err != nil {
		return "", err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data[key], nil
}

// ReadAll behaves like Read but returns a copy of the full store contents.
func (s *Store) ReadAll(ctx context.Context, target uint64) (map[string]string, error) {
	if err := s.notifier.Wait(ctx, target); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out, nil
}

// MustRead is a convenience wrapper for tests and call sites that have
// already guaranteed the target is applied.
func (s *Store) MustRead(ctx context.Context, target uint64, key string) string {
	v, err := s.Read(ctx, target, key)
	if err != nil {
		panic(fmt.Sprintf("readwait: MustRead: %v", err))
	}
	return v
}
