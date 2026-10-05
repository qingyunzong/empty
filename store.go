// Package objstore implements a content-addressed object store with
// tree references, temporary uploads, version roots and a mark-sweep
// garbage collector that is safe against concurrent mutations.
//
// Safety invariants:
//   - Every object referenced by a version root, directly or through a
//     chain of tree references, is never deleted.
//   - Objects created by Put or committed uploads are protected by a
//     temporary lease (Options.MinAge) so callers have a grace period
//     to anchor them to a root or another reachable object.
//   - While a GC cycle is running, Put and SetRoot act as write
//     barriers: anything they make reachable is marked, so the
//     concurrent collector never sweeps a reachable object.
//   - Every deletion is journaled before it is applied and carries an
//     Evidence record (root snapshot, root generation, GC cycle) that
//     proves the object was unreachable at sweep time.
package objstore

import (
	"bytes"
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

// ID is a content-addressed object identifier (hex-encoded SHA-256).
type ID string

// ErrNotFound is returned when an object or root does not exist.
var ErrNotFound = errors.New("objstore: not found")

// Object is a stored value together with its outgoing tree references.
type Object struct {
	ID      ID
	Refs    []ID
	Created time.Time
	Data    []byte
}

// Evidence is the unreachability proof attached to every deletion.
// It is returned by Collect and journaled ahead of the actual file
// removal so a crash mid-sweep can be audited and recovered.
type Evidence struct {
	Cycle          uint64        `json:"cycle"`
	Object         ID            `json:"object"`
	RootGeneration uint64        `json:"root_generation"`
	Roots          map[string]ID `json:"roots"`
	Marked         int           `json:"marked"`
	Reason         string        `json:"reason"`
	Time           time.Time     `json:"time"`
}

// Hooks are injectable phase barriers inside a GC cycle. They exist so
// tests (and embedders) can deterministically interleave mutations with
// collector phases. Hooks run without any store lock held, so they may
// call back into the store.
type Hooks struct {
	// AfterRootSnapshot runs after roots and live temp uploads have
	// been snapshotted, before marking starts.
	AfterRootSnapshot func()
	// AfterMark runs after the mark phase, before sweeping.
	AfterMark func()
	// BeforeDelete runs after a deletion has been journaled but before
	// the object file is removed. Returning an error aborts the cycle
	// (used to simulate a crash mid-sweep).
	BeforeDelete func(id ID) error
}

// Options configures a Store.
type Options struct {
	// MinAge is the temp-upload lease: unreferenced objects younger
	// than this are protected from GC. Defaults to one minute.
	MinAge time.Duration
	// Hooks are GC phase barriers, mainly for testing.
	Hooks Hooks
	// Now overrides the clock (for tests). Defaults to time.Now.
	Now func() time.Time
}

type objHeader struct {
	Refs    []ID      `json:"refs"`
	Created time.Time `json:"created"`
}

// Store is a persistent object store rooted at a directory.
type Store struct {
	dir    string
	objDir string

	mu      sync.Mutex
	roots   map[string]ID
	rootGen uint64
	temps   map[ID]time.Time // committed temp uploads -> commit time
	cycle   *cycleState      // non-nil while a GC cycle is running
	cycleID uint64

	gcMu sync.Mutex // serializes Collect

	j      *journal
	hooks  Hooks
	minAge time.Duration
	now    func() time.Time

	debugCrash bool // test-only: skip gc-end/compact to simulate a crash
}

const tmpPrefix = ".tmp-"

// Open opens (or creates) a store in dir and replays the journal to
// recover from any crash that happened mid-GC.
func Open(dir string, opts *Options) (*Store, error) {
	o := Options{MinAge: time.Minute, Now: time.Now}
	if opts != nil {
		if opts.MinAge > 0 {
			o.MinAge = opts.MinAge
		}
		o.Hooks = opts.Hooks
		if opts.Now != nil {
			o.Now = opts.Now
		}
	}
	objDir := filepath.Join(dir, "objects")
	if err := os.MkdirAll(objDir, 0o755); err != nil {
		return nil, err
	}
	// Remove leftover temp files from interrupted writes.
	if entries, err := os.ReadDir(objDir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), tmpPrefix) {
				os.Remove(filepath.Join(objDir, e.Name()))
			}
		}
	}

	s := &Store{
		dir:    dir,
		objDir: objDir,
		roots:  make(map[string]ID),
		temps:  make(map[ID]time.Time),
		hooks:  o.Hooks,
		minAge: o.MinAge,
		now:    o.Now,
	}

	// Replay the journal: rebuild roots and temp leases, and re-apply
	// deletions from a GC cycle that never completed (crash mid-sweep).
	jpath := filepath.Join(dir, "journal.log")
	var pending []Evidence
	inCycle := false
	if data, err := os.ReadFile(jpath); err == nil {
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			if len(line) == 0 {
				continue
			}
			var e entry
			if err := json.Unmarshal(line, &e); err != nil {
				continue // tolerate a torn tail write
			}
			switch e.Op {
			case opPut:
				committed := time.Unix(0, e.Committed)
				if o.Now().Sub(committed) < o.MinAge {
					s.temps[e.ID] = committed
				}
			case opRoot:
				s.roots[e.Name] = e.Root
				s.rootGen = e.Gen
			case opDelRoot:
				delete(s.roots, e.Name)
				s.rootGen = e.Gen
			case opGCBegin:
				inCycle = true
				pending = nil
			case opDelete:
				if inCycle && e.Ev != nil {
					pending = append(pending, *e.Ev)
				}
			case opGCEnd:
				inCycle = false
				pending = nil
			}
		}
	}
	if len(pending) > 0 {
		// Re-apply journaled deletions, but never remove an object that
		// is reachable from the recovered roots or still lease-protected:
		// a write barrier may have revived it after the evidence was
		// journaled.
		reach := reachableSet(objDir, s.roots)
		for _, ev := range pending {
			if reach[ev.Object] {
				continue
			}
			if t, ok := s.temps[ev.Object]; ok && o.Now().Sub(t) < o.MinAge {
				continue
			}
			os.Remove(objPath(objDir, ev.Object))
		}
	}

	j, err := openJournal(jpath)
	if err != nil {
		return nil, err
	}
	s.j = j
	if err := s.j.compactLocked(s.roots, s.temps, s.rootGen); err != nil {
		return nil, err
	}
	return s, nil
}

// Close flushes and closes the store's journal.
func (s *Store) Close() error {
	s.gcMu.Lock()
	defer s.gcMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.j != nil {
		s.j.close()
		s.j = nil
	}
	return nil
}

// Put stores data with outgoing tree references and returns its
// content-addressed ID. All refs must already exist. The new object is
// lease-protected (see Options.MinAge) so the caller has time to anchor
// it; during a GC cycle Put also acts as a write barrier.
func (s *Store) Put(data []byte, refs []ID) (ID, error) {
	for _, r := range refs {
		if !validID(r) {
			return "", fmt.Errorf("objstore: invalid reference %q", r)
		}
	}
	h := sha256.New()
	for _, r := range refs {
		h.Write([]byte(r))
		h.Write([]byte{0})
	}
	h.Write(data)
	id := ID(hex.EncodeToString(h.Sum(nil)))

	hdr, err := json.Marshal(objHeader{Refs: refs, Created: s.now()})
	if err != nil {
		return "", err
	}

	// Register the lease and run the write barrier before the file
	// becomes visible, so a concurrent sweep can never observe the file
	// without protection.
	s.mu.Lock()
	for _, r := range refs {
		if !s.hasLocked(r) {
			s.mu.Unlock()
			return "", fmt.Errorf("objstore: reference %s: %w", r, ErrNotFound)
		}
	}
	s.temps[id] = s.now()
	if s.cycle != nil {
		s.cycle.add(id)
		s.cycle.add(refs...)
	}
	err = s.j.appendLocked(entry{Op: opPut, ID: id, Committed: s.now().UnixNano()})
	s.mu.Unlock()
	if err != nil {
		return "", err
	}

	var buf bytes.Buffer
	buf.Write(hdr)
	buf.WriteByte('\n')
	buf.Write(data)
	tmp, err := os.CreateTemp(s.objDir, tmpPrefix+"*")
	if err != nil {
		return "", err
	}
	if _, err := tmp.Write(buf.Bytes()); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return id, os.Rename(tmp.Name(), s.objPath(id))
}

// Get loads an object by ID.
func (s *Store) Get(id ID) (*Object, error) {
	data, err := os.ReadFile(s.objPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("objstore: object %s: %w", id, ErrNotFound)
		}
		return nil, err
	}
	i := bytes.IndexByte(data, '\n')
	if i < 0 {
		return nil, fmt.Errorf("objstore: corrupt object %s", id)
	}
	var hdr objHeader
	if err := json.Unmarshal(data[:i], &hdr); err != nil {
		return nil, fmt.Errorf("objstore: corrupt object %s: %w", id, err)
	}
	return &Object{ID: id, Refs: hdr.Refs, Created: hdr.Created, Data: data[i+1:]}, nil
}

// Has reports whether an object exists.
func (s *Store) Has(id ID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hasLocked(id)
}

func (s *Store) hasLocked(id ID) bool {
	if !validID(id) {
		return false
	}
	_, err := os.Stat(s.objPath(id))
	return err == nil
}

// SetRoot atomically creates or replaces the version root name,
// pinning id and its whole reference tree. During a GC cycle SetRoot
// acts as a write barrier so the newly rooted tree cannot be swept.
func (s *Store) SetRoot(name string, id ID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasLocked(id) {
		return fmt.Errorf("objstore: root target %s: %w", id, ErrNotFound)
	}
	gen := s.rootGen + 1
	if err := s.j.appendLocked(entry{Op: opRoot, Name: name, Root: id, Gen: gen}); err != nil {
		return err
	}
	s.rootGen = gen
	s.roots[name] = id
	if s.cycle != nil {
		s.cycle.add(id)
	}
	return nil
}

// DeleteRoot removes a version root. Deleting a missing root is a no-op.
func (s *Store) DeleteRoot(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.roots[name]; !ok {
		return nil
	}
	gen := s.rootGen + 1
	if err := s.j.appendLocked(entry{Op: opDelRoot, Name: name, Gen: gen}); err != nil {
		return err
	}
	s.rootGen = gen
	delete(s.roots, name)
	return nil
}

// Roots returns a snapshot of the current version roots.
func (s *Store) Roots() map[string]ID {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]ID, len(s.roots))
	for k, v := range s.roots {
		out[k] = v
	}
	return out
}

// RootGeneration returns the current root generation, bumped on every
// root mutation.
func (s *Store) RootGeneration() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rootGen
}

func (s *Store) objPath(id ID) string { return objPath(s.objDir, id) }

func objPath(objDir string, id ID) string {
	return filepath.Join(objDir, string(id))
}

func validID(id ID) bool {
	if len(id) != 64 {
		return false
	}
	for _, c := range id {
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}

func readHeaderRefs(path string) ([]ID, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	i := bytes.IndexByte(data, '\n')
	if i < 0 {
		return nil, errors.New("objstore: corrupt object")
	}
	var hdr objHeader
	if err := json.Unmarshal(data[:i], &hdr); err != nil {
		return nil, err
	}
	return hdr.Refs, nil
}

// reachableSet computes the transitive closure of roots on disk. It is
// used during crash recovery.
func reachableSet(objDir string, roots map[string]ID) map[ID]bool {
	seen := make(map[ID]bool)
	var stack []ID
	for _, id := range roots {
		stack = append(stack, id)
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		refs, err := readHeaderRefs(objPath(objDir, id))
		if err != nil {
			continue
		}
		stack = append(stack, refs...)
	}
	return seen
}

// listObjects returns all object IDs on disk, sorted for determinism.
func (s *Store) listObjects() ([]ID, error) {
	entries, err := os.ReadDir(s.objDir)
	if err != nil {
		return nil, err
	}
	var ids []ID
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			continue
		}
		id := ID(e.Name())
		if validID(id) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

// Upload is a temporary, not yet committed object upload.
type Upload struct {
	s    *Store
	mu   sync.Mutex
	buf  bytes.Buffer
	refs []ID
	done bool
}

// BeginUpload starts a temporary upload. Nothing is persisted until
// Commit; the committed object is lease-protected like any Put.
func (s *Store) BeginUpload() *Upload {
	return &Upload{s: s}
}

// Write appends upload payload data.
func (u *Upload) Write(p []byte) (int, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return 0, errors.New("objstore: upload already finished")
	}
	return u.buf.Write(p)
}

// AddRef adds an outgoing tree reference to the uploaded object.
func (u *Upload) AddRef(id ID) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return errors.New("objstore: upload already finished")
	}
	u.refs = append(u.refs, id)
	return nil
}

// Commit persists the upload and returns its object ID.
func (u *Upload) Commit() (ID, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return "", errors.New("objstore: upload already finished")
	}
	u.done = true
	return u.s.Put(u.buf.Bytes(), u.refs)
}

// Abort discards the upload.
func (u *Upload) Abort() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.done = true
	u.buf.Reset()
	u.refs = nil
}
