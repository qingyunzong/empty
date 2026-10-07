// Package pagestore implements a copy-on-write paged key/value store.
//
// Transactions never modify pages in place: every write lands on a freshly
// allocated page and consumes new-page quota. A commit publishes all dirty
// pages, syncs, and only then atomically switches the root pointer, so
// readers pinned to an older root keep seeing their snapshot. Pages
// superseded by a commit are reclaimed once no reader can observe them.
// If the page quota would be exceeded, the commit is rejected and the
// transaction draft is left intact so it can be retried later.
package pagestore

import (
	"encoding/binary"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sync"
)

// PageSize is the fixed size of every page in the store.
const PageSize = 4096

// PageID identifies a page within the store.
type PageID uint64

var (
	// ErrQuotaExceeded is returned by Commit when publishing the
	// transaction would push the store past its page capacity.
	ErrQuotaExceeded = errors.New("pagestore: commit exceeds page quota")
	// ErrTxnClosed is returned when using a finished transaction.
	ErrTxnClosed = errors.New("pagestore: transaction already closed")
	// ErrTxnConflict is returned when another writer committed first.
	ErrTxnConflict = errors.New("pagestore: transaction base version is stale")
	// ErrValueTooLarge is returned when a value does not fit in a page.
	ErrValueTooLarge = errors.New("pagestore: value exceeds page size")
	// ErrDirectoryTooBig is returned when the root directory overflows a page.
	ErrDirectoryTooBig = errors.New("pagestore: directory exceeds page size")
)

// Stats is a point-in-time view of the store's page accounting.
type Stats struct {
	Version     uint64
	Capacity    int // hard quota, in pages
	Used        int // pages currently charged against the quota
	Free        int // reclaimed pages available for reuse
	HiWater     int // highest page id ever handed out
	PendingFree int // superseded pages still pinned by old readers
}

// Store is a single-writer, multi-reader COW page store.
type Store struct {
	mu       sync.Mutex
	backend  Backend
	capacity int

	hiWater  PageID
	freelist []PageID

	root    PageID
	version uint64
	dir     map[string]PageID

	readers     map[uint64]int
	pendingFree map[uint64][]PageID // superseded version -> its pages
}

// Open creates a store on backend with a hard quota of capacity pages.
func Open(backend Backend, capacity int) (*Store, error) {
	if capacity < 1 {
		return nil, fmt.Errorf("pagestore: capacity must be >= 1, got %d", capacity)
	}
	s := &Store{
		backend:     backend,
		capacity:    capacity,
		dir:         make(map[string]PageID),
		readers:     make(map[uint64]int),
		pendingFree: make(map[uint64][]PageID),
	}
	root, err := marshalDir(s.dir)
	if err != nil {
		return nil, err
	}
	id := s.allocLocked()
	if err := s.backend.WritePage(id, root); err != nil {
		return nil, err
	}
	if err := s.backend.Sync(); err != nil {
		return nil, err
	}
	s.root = id
	return s, nil
}

// Stats returns the current page accounting.
func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := 0
	for _, pages := range s.pendingFree {
		pending += len(pages)
	}
	return Stats{
		Version:     s.version,
		Capacity:    s.capacity,
		Used:        s.usedLocked(),
		Free:        len(s.freelist),
		HiWater:     int(s.hiWater),
		PendingFree: pending,
	}
}

// allocLocked hands out a page id, preferring reclaimed pages.
func (s *Store) allocLocked() PageID {
	if n := len(s.freelist); n > 0 {
		id := s.freelist[n-1]
		s.freelist = s.freelist[:n-1]
		return id
	}
	id := s.hiWater
	s.hiWater++
	return id
}

func (s *Store) usedLocked() int { return int(s.hiWater) - len(s.freelist) }

// reclaimLocked returns superseded pages to the freelist once no active
// reader can still observe the version they belonged to.
func (s *Store) reclaimLocked() {
	minReader := s.version
	hasReader := false
	for v, n := range s.readers {
		if n > 0 && (!hasReader || v < minReader) {
			minReader, hasReader = v, true
		}
	}
	for v, pages := range s.pendingFree {
		if !hasReader || v < minReader {
			s.freelist = append(s.freelist, pages...)
			delete(s.pendingFree, v)
		}
	}
}

// View is a read snapshot pinned to one committed version.
type View struct {
	store   *Store
	version uint64
	dir     map[string]PageID
	closed  bool
}

// BeginRead pins the current committed version for reading.
func (s *Store) BeginRead() *View {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readers[s.version]++
	return &View{store: s, version: s.version, dir: maps.Clone(s.dir)}
}

// Get returns the value for key as of the pinned version.
func (v *View) Get(key string) ([]byte, bool, error) {
	if v.closed {
		return nil, false, errors.New("pagestore: view is closed")
	}
	id, ok := v.dir[key]
	if !ok {
		return nil, false, nil
	}
	data, err := v.store.backend.ReadPage(id)
	if err != nil {
		return nil, false, err
	}
	return trimPage(data), true, nil
}

// Close releases the snapshot and may unblock page reclamation.
func (v *View) Close() {
	if v.closed {
		return
	}
	v.closed = true
	s := v.store
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readers[v.version]--
	if s.readers[v.version] == 0 {
		delete(s.readers, v.version)
	}
	s.reclaimLocked()
}

type op struct {
	key string
	val []byte
	del bool
}

// Txn is a single-writer transaction. Its draft (ops) survives a failed
// commit, so Commit may be retried after quota frees up or the device
// recovers.
type Txn struct {
	store       *Store
	baseVersion uint64
	baseDir     map[string]PageID
	ops         []op
	done        bool
}

// Begin opens a write transaction on the current committed version.
func (s *Store) Begin() *Txn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &Txn{store: s, baseVersion: s.version, baseDir: maps.Clone(s.dir)}
}

// Put stages a key/value write. The value must fit in one page.
func (tx *Txn) Put(key string, val []byte) error {
	if tx.done {
		return ErrTxnClosed
	}
	if len(val) > PageSize {
		return ErrValueTooLarge
	}
	v := make([]byte, len(val))
	copy(v, val)
	tx.ops = append(tx.ops, op{key: key, val: v})
	return nil
}

// Delete stages a key removal.
func (tx *Txn) Delete(key string) error {
	if tx.done {
		return ErrTxnClosed
	}
	tx.ops = append(tx.ops, op{key: key, del: true})
	return nil
}

// Get reads through the transaction's own staged writes.
func (tx *Txn) Get(key string) ([]byte, bool, error) {
	if tx.done {
		return nil, false, ErrTxnClosed
	}
	for i := len(tx.ops) - 1; i >= 0; i-- {
		if tx.ops[i].key == key {
			if tx.ops[i].del {
				return nil, false, nil
			}
			return tx.ops[i].val, true, nil
		}
	}
	id, ok := tx.baseDir[key]
	if !ok {
		return nil, false, nil
	}
	data, err := tx.store.backend.ReadPage(id)
	if err != nil {
		return nil, false, err
	}
	return trimPage(data), true, nil
}

// Abort discards the draft.
func (tx *Txn) Abort() { tx.done = true }

type pageWrite struct {
	id   PageID
	data []byte
}

// Commit publishes the draft. On any failure (quota, write, sync) the
// store is left byte-for-byte unchanged: the root still points at the
// previous version, page accounting is rolled back, and the draft stays
// usable for a retry. On success the root switch is a single pointer swap
// performed after every new page is durable.
func (tx *Txn) Commit() error {
	if tx.done {
		return ErrTxnClosed
	}
	s := tx.store
	s.mu.Lock()
	defer s.mu.Unlock()

	if tx.baseVersion != s.version {
		tx.done = true
		return ErrTxnConflict
	}

	working := maps.Clone(tx.baseDir)
	var freed []PageID
	var dirty []pageWrite
	var fromFree []PageID
	fresh := 0

	alloc := func() PageID {
		if n := len(s.freelist); n > 0 {
			id := s.freelist[n-1]
			s.freelist = s.freelist[:n-1]
			fromFree = append(fromFree, id)
			return id
		}
		id := s.hiWater
		s.hiWater++
		fresh++
		return id
	}
	// rollback restores the exact pre-commit page accounting; the draft
	// (tx.ops) is deliberately untouched so the caller can retry.
	rollback := func() {
		s.freelist = append(s.freelist, fromFree...)
		s.hiWater -= PageID(fresh)
	}

	for _, o := range tx.ops {
		if old, ok := working[o.key]; ok {
			freed = append(freed, old)
			delete(working, o.key)
		}
		if o.del {
			continue
		}
		id := alloc()
		data := make([]byte, PageSize)
		copy(data, o.val)
		dirty = append(dirty, pageWrite{id: id, data: data})
		working[o.key] = id
	}
	rootData, err := marshalDir(working)
	if err != nil {
		rollback()
		return err
	}
	rootID := alloc()
	dirty = append(dirty, pageWrite{id: rootID, data: rootData})

	if s.usedLocked() > s.capacity {
		rollback()
		return ErrQuotaExceeded
	}

	for _, w := range dirty {
		if err := s.backend.WritePage(w.id, w.data); err != nil {
			rollback()
			return fmt.Errorf("pagestore: write page %d: %w", w.id, err)
		}
	}
	if err := s.backend.Sync(); err != nil {
		rollback()
		return fmt.Errorf("pagestore: sync: %w", err)
	}

	// Atomic root switch: everything above is durable, this is the only
	// moment readers can observe the new version.
	oldVersion, oldRoot := s.version, s.root
	s.root = rootID
	s.version++
	s.dir = working
	s.pendingFree[oldVersion] = append(s.pendingFree[oldVersion], append(freed, oldRoot)...)
	s.reclaimLocked()

	tx.done = true
	return nil
}

// marshalDir renders the key->page directory deterministically.
func marshalDir(dir map[string]PageID) ([]byte, error) {
	keys := slices.Sorted(maps.Keys(dir))
	size := 4
	for _, k := range keys {
		size += 2 + len(k) + 8
	}
	if size > PageSize {
		return nil, ErrDirectoryTooBig
	}
	buf := make([]byte, PageSize)
	binary.LittleEndian.PutUint32(buf, uint32(len(keys)))
	off := 4
	for _, k := range keys {
		binary.LittleEndian.PutUint16(buf[off:], uint16(len(k)))
		off += 2
		copy(buf[off:], k)
		off += len(k)
		binary.LittleEndian.PutUint64(buf[off:], uint64(dir[k]))
		off += 8
	}
	return buf, nil
}

// trimPage strips the zero padding from a data page.
func trimPage(data []byte) []byte {
	end := len(data)
	for end > 0 && data[end-1] == 0 {
		end--
	}
	return data[:end]
}
