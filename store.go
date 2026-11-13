package dataeng

import (
	"sort"
	"sync"
)

// FeatureStore supplies the version history of features for a join key.
//
// Implementations may be backed by a database, a streaming materializer or an
// in-memory table. The returned slices must be safe for the caller to inspect
// without further synchronization.
type FeatureStore[K comparable, V any] interface {
	Versions(key K) ([]FeatureVersion[K, V], error)
}

// MemoryStore is a thread-safe in-memory FeatureStore, mainly for tests and for
// embedding into offline backfill jobs. Versions are kept in the canonical
// point-in-time selection order:
//
//	event time desc, source sequence desc, created time desc
type MemoryStore[K comparable, V any] struct {
	mu       sync.RWMutex
	versions map[K][]FeatureVersion[K, V]
}

// NewMemoryStore creates an empty in-memory store.
func NewMemoryStore[K comparable, V any]() *MemoryStore[K, V] {
	return &MemoryStore[K, V]{
		versions: make(map[K][]FeatureVersion[K, V]),
	}
}

// Put adds one or more versions and restores canonical ordering.
func (s *MemoryStore[K, V]) Put(versions ...FeatureVersion[K, V]) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, version := range versions {
		s.versions[version.Key] = append(s.versions[version.Key], version)
	}
	for key := range s.versions {
		sortVersions(s.versions[key])
	}
}

// Versions returns a copy of the version history for key in canonical order.
func (s *MemoryStore[K, V]) Versions(key K) ([]FeatureVersion[K, V], error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	history := s.versions[key]
	if len(history) == 0 {
		return nil, nil
	}
	out := make([]FeatureVersion[K, V], len(history))
	copy(out, history)
	return out, nil
}

func sortVersions[K comparable, V any](versions []FeatureVersion[K, V]) {
	sort.SliceStable(versions, func(i, j int) bool {
		a, b := versions[i], versions[j]
		if !a.EventTime.Equal(b.EventTime) {
			return a.EventTime.After(b.EventTime)
		}
		if a.SourceSequence != b.SourceSequence {
			return a.SourceSequence > b.SourceSequence
		}
		return a.CreatedTime.After(b.CreatedTime)
	})
}
