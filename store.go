package q216

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// MemoryStore keeps state in memory. It is safe for concurrent use and is
// handy as an injected backend in tests.
type MemoryStore struct {
	mu    sync.RWMutex
	state *State
}

// NewMemoryStore creates an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Load returns a copy of the in-memory state.
func (m *MemoryStore) Load(context.Context) (*State, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.state == nil {
		return nil, ErrUninitialized
	}
	return m.state.Clone(), nil
}

// Save replaces the in-memory state atomically with respect to other calls.
func (m *MemoryStore) Save(_ context.Context, state *State) error {
	if state == nil {
		return fmt.Errorf("%w: cannot save nil state", ErrPersist)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state = state.Clone()
	return nil
}

// FileStore persists state as a single JSON file. Writes go through a
// temporary file in the same directory, are fsynced and then atomically
// renamed over the target, so readers never observe a partially written
// root/version record.
type FileStore struct {
	path string
	mode os.FileMode
}

// NewFileStore creates a FileStore at path. The parent directory is
// created on first Save when it does not exist.
func NewFileStore(path string) *FileStore {
	return &FileStore{path: path, mode: 0o600}
}

// WithMode sets the file mode used when writing the state file.
func (f *FileStore) WithMode(mode os.FileMode) *FileStore {
	f.mode = mode
	return f
}

// Load reads and decodes the state file.
func (f *FileStore) Load(context.Context) (*State, error) {
	data, err := os.ReadFile(f.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrUninitialized
		}
		return nil, fmt.Errorf("%w: reading state file: %v", ErrPersist, err)
	}
	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("%w: decoding state file: %v", ErrPersist, err)
	}
	if len(state.Root) == 0 || state.RootVersion <= 0 {
		return nil, fmt.Errorf("%w: state file is missing the trusted root", ErrPersist)
	}
	return &state, nil
}

// Save writes state via a temp file, fsync and atomic rename.
func (f *FileStore) Save(_ context.Context, state *State) error {
	if state == nil {
		return fmt.Errorf("%w: cannot save nil state", ErrPersist)
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("%w: creating state directory: %v", ErrPersist, err)
	}
	tmp, err := os.CreateTemp(dir, ".q216-state-*")
	if err != nil {
		return fmt.Errorf("%w: creating temp state file: %v", ErrPersist, err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	encoder := json.NewEncoder(tmp)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(state); err != nil {
		return fmt.Errorf("%w: encoding state: %v", ErrPersist, err)
	}
	if err := tmp.Chmod(f.mode); err != nil {
		return fmt.Errorf("%w: setting state file mode: %v", ErrPersist, err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("%w: fsync state file: %v", ErrPersist, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("%w: closing state file: %v", ErrPersist, err)
	}
	if err := os.Rename(tmpName, f.path); err != nil {
		return fmt.Errorf("%w: atomic rename failed: %v", ErrPersist, err)
	}

	// Best-effort directory fsync so the rename itself is durable.
	if dirHandle, err := os.Open(dir); err == nil {
		_ = dirHandle.Sync()
		_ = dirHandle.Close()
	}
	return nil
}
