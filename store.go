package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// MemoryStore is an in-memory StateStore useful for tests and local runners.
type MemoryStore struct {
	mu     sync.RWMutex
	state  *State
	saves  int
	loads  int
	closed bool
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore { return &MemoryStore{} }

// Load implements StateStore.
func (s *MemoryStore) Load(ctx context.Context) (State, error) {
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loads++
	if s.state == nil {
		return State{}, ErrStateNotFound
	}
	state := s.state.Clone()
	if err := state.Validate(); err != nil {
		return State{}, err
	}
	return state, nil
}

// Save implements StateStore.
func (s *MemoryStore) Save(ctx context.Context, state State) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := state.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("dataeng: memory store is closed")
	}
	clone := state.Clone()
	s.state = &clone
	s.saves++
	return nil
}

// Current returns a copy of the latest state, if any.
func (s *MemoryStore) Current() (State, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state == nil {
		return State{}, false
	}
	return s.state.Clone(), true
}

// Stats returns save and load counts.
func (s *MemoryStore) Stats() (saves, loads int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.saves, s.loads
}

// Close makes future saves fail. It is used to emulate a dead disk.
func (s *MemoryStore) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}

type fileEnvelope struct {
	Format   int             `json:"format"`
	State    json.RawMessage `json:"state"`
	Checksum string          `json:"checksum"`
}

const fileEnvelopeFormat = 1

// FileStateStore persists checkpoints as an atomically replaced JSON file.
// Saves fsync the file and its directory, so a crash leaves either the old or
// the new complete checkpoint.
type FileStateStore struct {
	path string
	mu   sync.Mutex
}

// NewFileStateStore returns a store backed by path. The directory is created
// on the first save.
func NewFileStateStore(path string) *FileStateStore {
	return &FileStateStore{path: path}
}

// Path returns the checkpoint path.
func (s *FileStateStore) Path() string { return s.path }

// Load implements StateStore.
func (s *FileStateStore) Load(ctx context.Context) (State, error) {
	if err := ctx.Err(); err != nil {
		return State{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, ErrStateNotFound
	}
	if err != nil {
		return State{}, fmt.Errorf("dataeng: read state %s: %w", s.path, err)
	}
	var envelope fileEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return State{}, fmt.Errorf("dataeng: decode state %s: %w", s.path, err)
	}
	if envelope.Format != fileEnvelopeFormat {
		return State{}, fmt.Errorf("%w: unsupported file format %d", ErrInvalidState, envelope.Format)
	}
	var state State
	if err := json.Unmarshal(envelope.State, &state); err != nil {
		return State{}, fmt.Errorf("dataeng: decode state payload %s: %w", s.path, err)
	}
	if err := state.Validate(); err != nil {
		return State{}, err
	}
	canonical, err := json.Marshal(state)
	if err != nil {
		return State{}, fmt.Errorf("dataeng: canonicalize state %s: %w", s.path, err)
	}
	sum := sha256.Sum256(canonical)
	if hex.EncodeToString(sum[:]) != envelope.Checksum {
		return State{}, fmt.Errorf("%w: %s", ErrStateChecksum, s.path)
	}
	return state, nil
}

// Save implements StateStore.
func (s *FileStateStore) Save(ctx context.Context, state State) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := state.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("dataeng: marshal state: %w", err)
	}
	sum := sha256.Sum256(data)
	envelope, err := json.MarshalIndent(fileEnvelope{
		Format:   fileEnvelopeFormat,
		State:    data,
		Checksum: hex.EncodeToString(sum[:]),
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("dataeng: marshal state envelope: %w", err)
	}
	directory := filepath.Dir(s.path)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return fmt.Errorf("dataeng: create state directory %s: %w", directory, err)
	}
	temp, err := os.CreateTemp(directory, "."+filepath.Base(s.path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("dataeng: create temporary state: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("dataeng: chmod temporary state: %w", err)
	}
	if _, err := temp.Write(envelope); err != nil {
		_ = temp.Close()
		return fmt.Errorf("dataeng: write temporary state: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("dataeng: sync temporary state: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("dataeng: close temporary state: %w", err)
	}
	if err := os.Rename(tempName, s.path); err != nil {
		return fmt.Errorf("dataeng: replace state: %w", err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("dataeng: open state directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("dataeng: sync state directory: %w", err)
	}
	return nil
}
