package dataeng

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// snapshotVersion is the on-disk format version embedded in every file.
const snapshotVersion = 1

// Snapshot is the serializable representation of a State.
type Snapshot struct {
	Version   int                 `json:"version"`
	Mailboxes map[string]*Mailbox `json:"mailboxes"`
}

// Store persists and restores state snapshots. Implementations must be safe
// for concurrent use.
type Store interface {
	// Save atomically persists the snapshot.
	Save(ctx context.Context, snapshot Snapshot) error

	// Load returns the last persisted snapshot. It returns ErrNoSnapshot when
	// nothing has been saved yet.
	Load(ctx context.Context) (Snapshot, error)
}

// Snapshot returns a deep copy of the current state suitable for persistence.
// The returned value shares no maps or slices with the live State.
func (s *State) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return Snapshot{
		Version:   snapshotVersion,
		Mailboxes: cloneMailboxes(s.mailboxes),
	}
}

// Restore replaces the current state with a deep copy of snapshot. The
// snapshot is validated first, so a malformed snapshot leaves the receiver
// untouched.
func (s *State) Restore(snapshot Snapshot) error {
	if err := validateSnapshot(snapshot); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	s.mailboxes = cloneMailboxes(snapshot.Mailboxes)
	return nil
}

// Save persists the current state through store.
func (s *State) Save(ctx context.Context, store Store) error {
	return store.Save(ctx, s.Snapshot())
}

// Load restores state previously persisted through store. A store without a
// snapshot (ErrNoSnapshot) leaves the state untouched and returns false.
func (s *State) Load(ctx context.Context, store Store) (bool, error) {
	snapshot, err := store.Load(ctx)
	if err != nil {
		if errors.Is(err, ErrNoSnapshot) {
			return false, nil
		}
		return false, err
	}
	if err := s.Restore(snapshot); err != nil {
		return false, err
	}
	return true, nil
}

func validateSnapshot(snapshot Snapshot) error {
	if snapshot.Version != snapshotVersion {
		return fmt.Errorf("%w: unsupported snapshot version %d", ErrInvalidArgument, snapshot.Version)
	}
	for name, mb := range snapshot.Mailboxes {
		if name == "" || mb == nil || name != mb.Name || len(mb.Generations) == 0 {
			return ErrInvalidArgument
		}
		for i, gen := range mb.Generations {
			if gen == nil || gen.Number != i+1 || gen.UIDValidity == 0 ||
				gen.Messages == nil || gen.Tombstones == nil {
				return ErrInvalidArgument
			}
		}
	}
	return nil
}

func cloneMailboxes(src map[string]*Mailbox) map[string]*Mailbox {
	dst := make(map[string]*Mailbox, len(src))
	for name, mb := range src {
		clone := &Mailbox{
			Name:        mb.Name,
			Generations: make([]*Generation, len(mb.Generations)),
		}
		for i, gen := range mb.Generations {
			messages := make(map[uint32]Message, len(gen.Messages))
			for uid, msg := range gen.Messages {
				msg.Flags = cloneStrings(msg.Flags)
				messages[uid] = msg
			}
			tombstones := make(map[uint32]Tombstone, len(gen.Tombstones))
			for uid, ts := range gen.Tombstones {
				tombstones[uid] = ts
			}
			genCopy := *gen
			genCopy.Messages = messages
			genCopy.Tombstones = tombstones
			clone.Generations[i] = &genCopy
		}
		dst[name] = clone
	}
	return dst
}

func cloneStrings(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

// FileStore keeps a single JSON snapshot on disk and replaces it atomically
// by writing a temporary file in the same directory and renaming it.
type FileStore struct {
	path string
}

// NewFileStore creates a FileStore backed by path. Parent directories are
// created on the first Save.
func NewFileStore(path string) *FileStore {
	return &FileStore{path: path}
}

// Path returns the snapshot file path.
func (f *FileStore) Path() string {
	return f.path
}

// Save implements Store.
func (f *FileStore) Save(ctx context.Context, snapshot Snapshot) error {
	if err := validateSnapshot(snapshot); err != nil {
		return err
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, ".imapstate-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	encoder := json.NewEncoder(tmp)
	encoder.SetIndent("", "  ")
	encodeErr := encoder.Encode(snapshot)
	closeErr := tmp.Close()
	if encodeErr != nil {
		_ = os.Remove(tmpName)
		return encodeErr
	}
	if closeErr != nil {
		_ = os.Remove(tmpName)
		return closeErr
	}

	if err := ctx.Err(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, f.path)
}

// Load implements Store.
func (f *FileStore) Load(ctx context.Context) (Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	data, err := os.ReadFile(f.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Snapshot{}, ErrNoSnapshot
		}
		return Snapshot{}, err
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return Snapshot{}, err
	}
	if err := validateSnapshot(snapshot); err != nil {
		return Snapshot{}, err
	}
	return snapshot, nil
}

// MemoryStore keeps the latest snapshot in memory. It is useful for tests and
// for embedding the state inside another persistence mechanism.
type MemoryStore struct {
	snapshot Snapshot
	has      bool
}

// NewMemoryStore creates an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}

// Save implements Store.
func (m *MemoryStore) Save(_ context.Context, snapshot Snapshot) error {
	if err := validateSnapshot(snapshot); err != nil {
		return err
	}
	m.snapshot = Snapshot{
		Version:   snapshotVersion,
		Mailboxes: cloneMailboxes(snapshot.Mailboxes),
	}
	m.has = true
	return nil
}

// Load implements Store.
func (m *MemoryStore) Load(_ context.Context) (Snapshot, error) {
	if !m.has {
		return Snapshot{}, ErrNoSnapshot
	}
	return Snapshot{
		Version:   snapshotVersion,
		Mailboxes: cloneMailboxes(m.snapshot.Mailboxes),
	}, nil
}
