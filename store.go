package commlib

import (
	"errors"
	"sort"
	"sync"
)

// Op is a single write inside an atomic batch. A nil Value deletes the key.
type Op struct {
	Key    string
	Value  []byte
	Delete bool
}

// Store is a durable key-value store. ApplyBatch must be atomic: either all
// ops commit or none do. This is the primitive both sides use to make
// outbox/inbox writes transactional.
type Store interface {
	Get(key string) (value []byte, ok bool, err error)
	ApplyBatch(ops []Op) error
	Keys() ([]string, error)
}

// MemStore is an in-memory Store with atomic batches.
type MemStore struct {
	mu   sync.Mutex
	data map[string][]byte
}

func NewMemStore() *MemStore {
	return &MemStore{data: make(map[string][]byte)}
}

func (m *MemStore) Get(key string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.data[key]
	if !ok {
		return nil, false, nil
	}
	return append([]byte(nil), v...), true, nil
}

func (m *MemStore) ApplyBatch(ops []Op) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, op := range ops {
		if op.Delete {
			delete(m.data, op.Key)
		} else {
			m.data[op.Key] = append([]byte(nil), op.Value...)
		}
	}
	return nil
}

func (m *MemStore) Keys() ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.data))
	for k := range m.data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys, nil
}

// ErrInjected is returned by FaultyStore when an injected failure fires.
var ErrInjected = errors.New("commlib: injected persistence failure")

// FaultyStore wraps a Store and injects persistence failures:
//
//   - before-commit: the batch is rejected and nothing is applied (crash
//     before the write).
//   - after-commit: the batch is applied but an error is reported (crash
//     after commit, before the caller sees the result). Retries then rely on
//     idempotency/dedup to stay correct.
type FaultyStore struct {
	inner Store

	mu               sync.Mutex
	failBeforeCommit int
	failAfterCommit  int
}

func NewFaultyStore(inner Store) *FaultyStore {
	return &FaultyStore{inner: inner}
}

// FailNextBatchBeforeCommit makes the next n batches fail without applying.
func (f *FaultyStore) FailNextBatchBeforeCommit(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failBeforeCommit += n
}

// FailNextBatchAfterCommit makes the next n batches apply but report failure.
func (f *FaultyStore) FailNextBatchAfterCommit(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAfterCommit += n
}

func (f *FaultyStore) Get(key string) ([]byte, bool, error) {
	return f.inner.Get(key)
}

func (f *FaultyStore) Keys() ([]string, error) {
	return f.inner.Keys()
}

func (f *FaultyStore) ApplyBatch(ops []Op) error {
	f.mu.Lock()
	if f.failBeforeCommit > 0 {
		f.failBeforeCommit--
		f.mu.Unlock()
		return ErrInjected
	}
	after := f.failAfterCommit > 0
	if after {
		f.failAfterCommit--
	}
	f.mu.Unlock()

	if err := f.inner.ApplyBatch(ops); err != nil {
		return err
	}
	if after {
		return ErrInjected
	}
	return nil
}
