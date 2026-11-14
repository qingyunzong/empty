package dataeng

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Store is the minimum object-store contract. Objects are addressed by
// slash-separated keys, Put stores exactly the supplied bytes, Get returns
// exactly those bytes, and List returns object keys under a prefix.
//
// Put is assumed to be atomic at the object level. Conditional writes are
// expressed separately by ConditionalStore so implementations backed by
// If-Match/If-None-Match capable services can provide linearizable arbitration.
type Store interface {
	Put(ctx context.Context, key string, data []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	List(ctx context.Context, prefix string) ([]string, error)
}

// ObjectStore is an alias kept for callers that prefer the more explicit
// name.
type ObjectStore = Store

// ConditionalStore adds an atomic compare-and-swap operation for one object.
//
// expected is an object token as returned by Token over the object's current
// bytes. The empty token means "the object must not exist". A failed
// precondition returns an error wrapping ErrConflict. Object services
// normally implement this as Put with If-Match/If-None-Match.
type ConditionalStore interface {
	Store
	PutIfMatch(ctx context.Context, key string, data []byte, expected string) error
}

// CASStore is an alias for ConditionalStore.
type CASStore = ConditionalStore

// Token returns the token used by ConditionalStore for an object's bytes.
// It returns "" for nil data, which denotes absence.
func Token(data []byte) string {
	return objectToken(data)
}

// MemoryStore is a concurrency-safe in-memory Store and ConditionalStore.
// It is useful for tests, local development and single-process publishers.
type MemoryStore struct {
	mu      sync.RWMutex
	objects map[string][]byte
}

// NewMemoryStore constructs an empty in-memory object store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{objects: make(map[string][]byte)}
}

// Put implements Store.
func (s *MemoryStore) Put(_ context.Context, key string, data []byte) error {
	if key == "" {
		return fmt.Errorf("dataeng: empty object key")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = cloneBytes(data)
	return nil
}

// Get implements Store.
func (s *MemoryStore) Get(_ context.Context, key string) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	data, ok := s.objects[key]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrObjectNotFound, key)
	}
	return cloneBytes(data), nil
}

// List implements Store. Results are sorted and include the full keys.
func (s *MemoryStore) List(_ context.Context, prefix string) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	keys := make([]string, 0)
	for key := range s.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}

// PutIfMatch implements ConditionalStore atomically.
func (s *MemoryStore) PutIfMatch(_ context.Context, key string, data []byte, expected string) error {
	if key == "" {
		return fmt.Errorf("dataeng: empty object key")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.objects[key]
	currentToken := ""
	if ok {
		currentToken = objectToken(current)
	}
	if currentToken != expected {
		return fmt.Errorf("%w: %s", ErrConflict, key)
	}
	s.objects[key] = cloneBytes(data)
	return nil
}

func cloneBytes(data []byte) []byte {
	if data == nil {
		return []byte{}
	}
	out := make([]byte, len(data))
	copy(out, data)
	return out
}

// StoreFunc adapts three functions to the Store interface. It is convenient
// for connecting an existing object-store client to a Writer or Reader.
type StoreFunc struct {
	PutFunc  func(ctx context.Context, key string, data []byte) error
	GetFunc  func(ctx context.Context, key string) ([]byte, error)
	ListFunc func(ctx context.Context, prefix string) ([]string, error)
}

// Put implements Store.
func (s StoreFunc) Put(ctx context.Context, key string, data []byte) error {
	if s.PutFunc == nil {
		return fmt.Errorf("dataeng: StoreFunc.PutFunc is nil")
	}
	return s.PutFunc(ctx, key, data)
}

// Get implements Store.
func (s StoreFunc) Get(ctx context.Context, key string) ([]byte, error) {
	if s.GetFunc == nil {
		return nil, fmt.Errorf("dataeng: StoreFunc.GetFunc is nil")
	}
	return s.GetFunc(ctx, key)
}

// List implements Store.
func (s StoreFunc) List(ctx context.Context, prefix string) ([]string, error) {
	if s.ListFunc == nil {
		return nil, fmt.Errorf("dataeng: StoreFunc.ListFunc is nil")
	}
	return s.ListFunc(ctx, prefix)
}

// fallbackLocks serializes the non-atomic fallback path within one process.
// Cross-process correctness against a Store with no conditional-write
// capability is impossible in general; such stores must expose PutIfMatch.
var fallbackLocks sync.Map

func keyedLock(key string) *sync.Mutex {
	value, _ := fallbackLocks.LoadOrStore(key, new(sync.Mutex))
	return value.(*sync.Mutex)
}

func putIfMatch(ctx context.Context, store Store, key string, data []byte, expected string) error {
	if conditional, ok := store.(ConditionalStore); ok {
		return conditional.PutIfMatch(ctx, key, data, expected)
	}

	// Keep the check+put atomic for all writers sharing this process. A
	// multi-process writer must use a ConditionalStore for this guarantee.
	lock := keyedLock(key)
	lock.Lock()
	defer lock.Unlock()

	current, err := store.Get(ctx, key)
	currentToken := ""
	switch {
	case err == nil:
		currentToken = objectToken(current)
	case IsNotFound(err):
	default:
		return err
	}
	if currentToken != expected {
		return fmt.Errorf("%w: %s", ErrConflict, key)
	}
	return store.Put(ctx, key, data)
}
