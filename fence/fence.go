// Package fence implements a shared-resource store guarded by fencing
// tokens. Every grant of write permission carries a strictly increasing
// fence number. A write is accepted only when its fence number is not
// lower than the highest number seen for the key and the holder matches
// the most recent grantee. Retries with an old number fail with ErrStale
// and never clobber a newer value. The maximum granted number is
// persisted so it survives crash recovery.
package fence

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

var (
	// ErrStale is returned when a write carries a fence number lower
	// than the highest number already seen for the key.
	ErrStale = errors.New("fence: stale token")
	// ErrNotHolder is returned when the writer is not the holder of the
	// current grant for the key.
	ErrNotHolder = errors.New("fence: holder mismatch")
)

type keyState struct {
	value   string
	fence   uint64
	holder  string
	granted bool
}

// Store is a concurrency-safe fenced key-value store.
type Store struct {
	mu      sync.Mutex
	counter uint64 // highest fence number ever granted
	path    string // persistence file for counter
	keys    map[string]*keyState
}

// Open creates or recovers a Store whose counter is persisted in path.
// On recovery the persisted maximum fence number is restored, so tokens
// never move backwards across restarts.
func Open(path string) (*Store, error) {
	s := &Store{path: path, keys: make(map[string]*keyState)}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		n, perr := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
		if perr != nil {
			return nil, fmt.Errorf("fence: corrupt state file %s: %w", path, perr)
		}
		s.counter = n
	case errors.Is(err, fs.ErrNotExist):
		// fresh store
	default:
		return nil, err
	}
	return s, nil
}

// persistLocked durably records the current counter. Callers must hold s.mu.
func (s *Store) persistLocked() error {
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(f, "%d\n", s.counter); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	// fsync the directory so the rename itself is durable.
	d, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// Grant issues a new write permission for key to holder and returns its
// fence number. Numbers are strictly increasing across all grants and
// are persisted before being handed out.
func (s *Store) Grant(key, holder string) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counter++
	if err := s.persistLocked(); err != nil {
		return 0, err
	}
	ks := s.keys[key]
	if ks == nil {
		ks = &keyState{}
		s.keys[key] = ks
	}
	ks.fence = s.counter
	ks.holder = holder
	ks.granted = true
	return s.counter, nil
}

// Write stores value for key if fence is not lower than the highest
// fence number seen for the key and holder matches the current grantee.
// A stale number returns ErrStale and leaves the stored value untouched.
func (s *Store) Write(key, holder string, fence uint64, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ks := s.keys[key]
	if ks == nil || !ks.granted {
		return ErrNotHolder
	}
	if fence < ks.fence {
		return ErrStale
	}
	if holder != ks.holder {
		return ErrNotHolder
	}
	ks.value = value
	ks.fence = fence
	return nil
}

// Read returns the stored value, the highest fence number seen, and the
// current holder for key.
func (s *Store) Read(key string) (value string, fence uint64, holder string, granted bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ks := s.keys[key]
	if ks == nil {
		return "", 0, "", false
	}
	return ks.value, ks.fence, ks.holder, ks.granted
}

// MaxFence returns the highest fence number ever granted by this store.
func (s *Store) MaxFence() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.counter
}
