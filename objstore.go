// Package objstore implements a content-addressed object store with tree
// references, temporary uploads (leases), version roots, and a garbage
// collector that is safe against concurrent root additions.
//
// Concurrency model:
//   - mu    guards in-memory roots/leases and the active GC pointer.
//   - gcMu  serializes object existence validation (AddRoot/AddLease/Put)
//     against GC deletion. Lock order is always gcMu -> mu.
//
// Durability: state (roots+leases) is persisted atomically via
// write-tmp/fsync/rename/fsync-dir. Every GC deletion is preceded by an
// fsynced evidence record in evidence.log.
package objstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Hash is a content-addressed object identifier (hex-encoded SHA-256).
type Hash string

// Object kinds.
const (
	KindBlob = "blob"
	KindTree = "tree"
)

// Object is a stored value: an opaque blob or a tree referencing children.
type Object struct {
	Kind string
	Data []byte
	Refs []Hash
}

type objectFile struct {
	Kind string `json:"kind"`
	Data []byte `json:"data,omitempty"`
	Refs []Hash `json:"refs,omitempty"`
}

// HashBlob computes the content address of a blob.
func HashBlob(data []byte) Hash {
	h := sha256.New()
	h.Write([]byte("blob\x00"))
	h.Write(data)
	return Hash(hex.EncodeToString(h.Sum(nil)))
}

// HashTree computes the content address of a tree over refs (order matters).
func HashTree(refs []Hash) Hash {
	h := sha256.New()
	h.Write([]byte("tree\x00"))
	for _, r := range refs {
		h.Write([]byte(r))
		h.Write([]byte{0})
	}
	return Hash(hex.EncodeToString(h.Sum(nil)))
}

// ErrNotExist is returned when an object (or an object it references) is
// missing from the store.
var ErrNotExist = errors.New("objstore: object does not exist")

type lease struct {
	Hash   Hash      `json:"hash"`
	Expiry time.Time `json:"expiry"`
}

type stateFile struct {
	Roots  map[string]Hash  `json:"roots"`
	Leases map[string]lease `json:"leases"`
}

// Barriers are injectable phase hooks executed at well-defined points of a
// GC cycle. They exist so tests (and embedders) can deterministically
// interleave operations — e.g. adding a root mid-scan — with the collector.
// Barriers run synchronously on the GC goroutine and must not call RunGC.
type Barriers struct {
	// AfterSnapshot runs after the root/lease snapshot is taken, before marking.
	AfterSnapshot func(s *Store)
	// AfterMark runs after the mark phase computed the reachable set.
	AfterMark func(s *Store)
	// BeforeSweep runs after the recheck pass, before any deletion.
	BeforeSweep func(s *Store)
	// BeforeDelete runs before each individual deletion (outside gcMu).
	BeforeDelete func(s *Store, h Hash)
}

// Store is a content-addressed object store rooted at a directory.
type Store struct {
	dir string

	mu     sync.Mutex
	gcMu   sync.Mutex
	roots  map[string]Hash
	leases map[string]lease
	active *gcState

	barriers Barriers
	now      func() time.Time

	// crashHook, if set, is invoked at labeled stages of state persistence
	// ("tmp", "rename") to simulate crashes in tests.
	crashHook func(stage string)

	evMu      sync.Mutex
	deletions []Evidence
}

// Open opens (or creates) a store at dir and performs crash recovery:
// stale temporary files from interrupted atomic writes are removed and the
// last fully committed state is loaded.
func Open(dir string) (*Store, error) {
	s := &Store{
		dir:    dir,
		roots:  map[string]Hash{},
		leases: map[string]lease{},
		now:    time.Now,
	}
	if err := os.MkdirAll(s.objectsDir(), 0o755); err != nil {
		return nil, err
	}
	// Recovery: remove leftovers of interrupted atomic writes.
	for _, pattern := range []string{
		filepath.Join(dir, "*.tmp"),
		filepath.Join(s.objectsDir(), "*.tmp"),
	} {
		matches, _ := filepath.Glob(pattern)
		for _, m := range matches {
			_ = os.Remove(m)
		}
	}
	data, err := os.ReadFile(s.statePath())
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var sf stateFile
	if err := json.Unmarshal(data, &sf); err != nil {
		return nil, fmt.Errorf("objstore: corrupt state file: %w", err)
	}
	if sf.Roots != nil {
		s.roots = sf.Roots
	}
	if sf.Leases != nil {
		s.leases = sf.Leases
	}
	return s, nil
}

func (s *Store) objectsDir() string { return filepath.Join(s.dir, "objects") }
func (s *Store) statePath() string  { return filepath.Join(s.dir, "state.json") }
func (s *Store) objectPath(h Hash) string {
	return filepath.Join(s.objectsDir(), string(h))
}

// SetBarriers installs GC phase barriers. Passing Barriers{} disables them.
func (s *Store) SetBarriers(b Barriers) { s.barriers = b }

// Roots returns a copy of the current version roots.
func (s *Store) Roots() map[string]Hash {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]Hash, len(s.roots))
	for k, v := range s.roots {
		out[k] = v
	}
	return out
}

// PutBlob stores data and returns its content address.
func (s *Store) PutBlob(data []byte) (Hash, error) {
	return s.putObject(KindBlob, data, nil)
}

// PutTree stores a tree node referencing refs. Every referenced object must
// already exist; the check is serialized against GC deletion so a tree can
// never be committed on top of objects the collector is removing.
func (s *Store) PutTree(refs []Hash) (Hash, error) {
	return s.putObject(KindTree, nil, refs)
}

func (s *Store) putObject(kind string, data []byte, refs []Hash) (Hash, error) {
	var h Hash
	if kind == KindBlob {
		h = HashBlob(data)
	} else {
		h = HashTree(refs)
	}
	s.gcMu.Lock()
	defer s.gcMu.Unlock()
	for _, r := range refs {
		if !s.objectExists(r) {
			return "", fmt.Errorf("objstore: put tree: referenced object %s: %w", r, ErrNotExist)
		}
	}
	of := objectFile{Kind: kind, Data: data, Refs: refs}
	if err := s.writeFileAtomic(s.objectPath(h), mustJSON(of)); err != nil {
		return "", err
	}
	// If a GC cycle is in flight, this (re-)upload must survive it.
	s.protectLocked(h)
	return h, nil
}

// Get loads an object by hash.
func (s *Store) Get(h Hash) (*Object, error) {
	data, err := os.ReadFile(s.objectPath(h))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotExist
	}
	if err != nil {
		return nil, err
	}
	var of objectFile
	if err := json.Unmarshal(data, &of); err != nil {
		return nil, fmt.Errorf("objstore: corrupt object %s: %w", h, err)
	}
	return &Object{Kind: of.Kind, Data: of.Data, Refs: of.Refs}, nil
}

func (s *Store) objectExists(h Hash) bool {
	_, err := os.Stat(s.objectPath(h))
	return err == nil
}

// AddRoot points the named version root at h. The full closure of h must
// exist. If a GC cycle is in flight, the closure is protected from deletion
// before the root becomes visible, so GC can never collect an object that a
// concurrently added root makes reachable.
func (s *Store) AddRoot(name string, h Hash) error {
	s.gcMu.Lock()
	if _, err := s.closure(h); err != nil {
		s.gcMu.Unlock()
		return fmt.Errorf("objstore: add root %q: %w", name, err)
	}
	s.protectLocked(h)
	s.gcMu.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.roots[name] = h
	return s.persistLocked()
}

// RemoveRoot deletes a version root.
func (s *Store) RemoveRoot(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.roots, name)
	return s.persistLocked()
}

// AddLease pins h as a temporary upload for ttl. The closure must exist and
// is protected from any in-flight GC, mirroring AddRoot.
func (s *Store) AddLease(id string, h Hash, ttl time.Duration) error {
	s.gcMu.Lock()
	if _, err := s.closure(h); err != nil {
		s.gcMu.Unlock()
		return fmt.Errorf("objstore: add lease %q: %w", id, err)
	}
	s.protectLocked(h)
	s.gcMu.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases[id] = lease{Hash: h, Expiry: s.now().Add(ttl)}
	return s.persistLocked()
}

// ReleaseLease removes a temporary upload lease.
func (s *Store) ReleaseLease(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.leases, id)
	return s.persistLocked()
}

// closure returns h plus every object reachable from h, or an error if any
// referenced object is missing. Callers must hold gcMu when racing GC.
func (s *Store) closure(root Hash) (map[Hash]bool, error) {
	out := map[Hash]bool{}
	stack := []Hash{root}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if out[h] {
			continue
		}
		obj, err := s.Get(h)
		if err != nil {
			return nil, err
		}
		out[h] = true
		stack = append(stack, obj.Refs...)
	}
	return out, nil
}

// protectLocked adds the closure of h to the active GC cycle's protected
// set. Must be called with gcMu held.
func (s *Store) protectLocked(h Hash) {
	s.mu.Lock()
	active := s.active
	s.mu.Unlock()
	if active == nil {
		return
	}
	cl, err := s.closure(h)
	if err != nil {
		return // best effort; callers validate existence separately
	}
	for c := range cl {
		active.protected[c] = true
	}
}

// liveLeasesLocked returns hashes with unexpired leases. Caller holds mu.
func (s *Store) liveLeasesLocked() map[Hash]bool {
	out := map[Hash]bool{}
	now := s.now()
	for _, l := range s.leases {
		if now.Before(l.Expiry) {
			out[l.Hash] = true
		}
	}
	return out
}

// persistLocked atomically writes roots+leases to state.json. Caller holds mu.
func (s *Store) persistLocked() error {
	sf := stateFile{Roots: s.roots, Leases: s.leases}
	return s.writeFileAtomic(s.statePath(), mustJSON(sf))
}

// writeFileAtomic writes data to path via tmp file + fsync + rename + dir fsync.
func (s *Store) writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
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
	if s.crashHook != nil {
		s.crashHook("tmp")
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if s.crashHook != nil {
		s.crashHook("rename")
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

// listObjects returns every fully written object hash in the store.
func (s *Store) listObjects() ([]Hash, error) {
	entries, err := os.ReadDir(s.objectsDir())
	if err != nil {
		return nil, err
	}
	var out []Hash
	for _, e := range entries {
		if e.IsDir() || strings.HasSuffix(e.Name(), ".tmp") {
			continue
		}
		out = append(out, Hash(e.Name()))
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}
