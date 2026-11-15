package snapshot

import (
	"context"
	"sort"
	"strings"
	"sync"
)

// Store is the object-storage abstraction the manifest library persists
// to. Rename must be atomic: it is the publish primitive for commits.
type Store interface {
	// Put creates or replaces an object.
	Put(ctx context.Context, key string, data []byte) error
	// Rename atomically moves oldKey to newKey, replacing newKey if it
	// exists. It returns ErrNotFound if oldKey does not exist.
	Rename(ctx context.Context, oldKey, newKey string) error
	// Get reads an object. It returns ErrNotFound if key does not exist.
	Get(ctx context.Context, key string) ([]byte, error)
	// Delete removes an object. Deleting a missing key is not an error.
	Delete(ctx context.Context, key string) error
	// List returns the keys under prefix in sorted order.
	List(ctx context.Context, prefix string) ([]string, error)
}

// MemStore is an in-memory Store, useful for tests and embedded use.
type MemStore struct {
	mu      sync.Mutex
	objects map[string][]byte
}

// NewMemStore returns an empty in-memory store.
func NewMemStore() *MemStore {
	return &MemStore{objects: make(map[string][]byte)}
}

func (s *MemStore) Put(_ context.Context, key string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = append([]byte(nil), data...)
	return nil
}

func (s *MemStore) Rename(_ context.Context, oldKey, newKey string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.objects[oldKey]
	if !ok {
		return ErrNotFound
	}
	s.objects[newKey] = data
	delete(s.objects, oldKey)
	return nil
}

func (s *MemStore) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, ok := s.objects[key]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), data...), nil
}

func (s *MemStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.objects, key)
	return nil
}

func (s *MemStore) List(_ context.Context, prefix string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var keys []string
	for key := range s.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}
