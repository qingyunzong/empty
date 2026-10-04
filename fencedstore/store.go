// Package fencedstore implements a shared resource store guarded by
// strictly increasing fencing tokens.
//
// A holder must first Grant a write lease for a resource, receiving a
// fence number that is strictly greater than any fence previously issued
// for that resource. A Write is accepted only when its fence is not lower
// than the current maximum fence and its holder matches the lease holder.
// Retried writes carrying an old fence are rejected with ErrStale and
// never affect the stored value. The maximum fence per resource is
// persisted to a write-ahead log (fsync'd before a grant returns), so the
// fence monotonicity survives process crashes and restarts.
package fencedstore

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// ErrStale is returned when a write carries a fence lower than the
// current maximum fence for the resource.
var ErrStale = errors.New("fencedstore: stale fence")

// ErrNotHolder is returned when the writer does not hold the current
// lease for the resource.
var ErrNotHolder = errors.New("fencedstore: holder mismatch")

type entry struct {
	maxFence uint64
	holder   string
	value    string
	hasValue bool
}

// walRecord is one persisted grant event.
type walRecord struct {
	Resource string `json:"resource"`
	Fence    uint64 `json:"fence"`
	Holder   string `json:"holder"`
}

// Store is a concurrency-safe fenced resource store.
type Store struct {
	mu        sync.Mutex
	resources map[string]*entry
	wal       *os.File
	enc       *json.Encoder
}

// Open creates or recovers a store persisted in dir. On recovery it
// replays the write-ahead log so every resource's maximum fence (and the
// holder of that fence) is restored exactly as before the crash.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "fence.wal")
	s := &Store{resources: make(map[string]*entry)}

	// Replay existing log, if any.
	if f, err := os.Open(path); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			var rec walRecord
			if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
				f.Close()
				return nil, fmt.Errorf("fencedstore: corrupt WAL: %w", err)
			}
			r := s.resources[rec.Resource]
			if r == nil {
				r = &entry{}
				s.resources[rec.Resource] = r
			}
			if rec.Fence > r.maxFence {
				r.maxFence = rec.Fence
				r.holder = rec.Holder
			}
		}
		if err := sc.Err(); err != nil {
			f.Close()
			return nil, err
		}
		f.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	wal, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	s.wal = wal
	s.enc = json.NewEncoder(wal)
	return s, nil
}

// Close flushes and closes the underlying WAL file.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wal == nil {
		return nil
	}
	err := s.wal.Close()
	s.wal = nil
	return err
}

// Grant issues a new write lease for resource to holder and returns a
// fence strictly greater than every fence previously issued for the
// resource. The new maximum fence is persisted and fsync'd before Grant
// returns, so a crash cannot roll it back.
func (s *Store) Grant(resource, holder string) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.resources[resource]
	if r == nil {
		r = &entry{}
		s.resources[resource] = r
	}
	fence := r.maxFence + 1
	rec := walRecord{Resource: resource, Fence: fence, Holder: holder}
	if err := s.enc.Encode(rec); err != nil {
		return 0, err
	}
	if err := s.wal.Sync(); err != nil {
		return 0, err
	}
	r.maxFence = fence
	r.holder = holder
	return fence, nil
}

// Write stores value for resource iff fence >= the resource's current
// maximum fence and holder matches the current lease holder. A lower
// fence yields ErrStale and leaves the stored value untouched; a holder
// mismatch yields ErrNotHolder.
func (s *Store) Write(resource, holder string, fence uint64, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.resources[resource]
	if r == nil {
		return ErrStale
	}
	if fence < r.maxFence {
		return ErrStale
	}
	if holder != r.holder {
		return ErrNotHolder
	}
	r.value = value
	r.hasValue = true
	return nil
}

// Read returns the current value of resource.
func (s *Store) Read(resource string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.resources[resource]
	if r == nil || !r.hasValue {
		return "", false
	}
	return r.value, true
}

// MaxFence reports the current maximum fence for resource (0 if none).
func (s *Store) MaxFence(resource string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.resources[resource]; r != nil {
		return r.maxFence
	}
	return 0
}
