// Package pagesnap implements a copy-on-write memory page store with
// forkable snapshots. Multiple branches (snapshots) may share the same
// physical page; a write through any branch transparently copies the page
// so concurrent branches never observe each other's modifications.
//
// Physical pages are reference counted: forking increments the count of
// every shared page, closing a snapshot decrements them, and a page is
// reclaimed only when its last referencing snapshot is closed.
package pagesnap

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// PageSize is the fixed size in bytes of every page in the store.
const PageSize = 4096

// ErrClosed is returned by operations on a snapshot that has been closed.
var ErrClosed = errors.New("pagesnap: snapshot is closed")

// ErrOverflow is returned when a write is larger than one page.
var ErrOverflow = errors.New("pagesnap: write exceeds page size")

type physPage struct {
	data [PageSize]byte
	refs int
}

// Stats summarizes the store state for diagnostics.
type Stats struct {
	LivePages     uint64 // physical pages currently allocated
	LiveSnapshots uint64 // snapshots not yet closed
	TotalRefs     uint64 // sum of reference counts over all live pages
	Allocs        uint64 // physical pages allocated since store creation
	Frees         uint64 // physical pages reclaimed since store creation
	CowCopies     uint64 // writes that triggered a copy-on-write
}

// Store owns all physical pages and the set of live snapshots.
// It is safe for concurrent use.
type Store struct {
	mu       sync.Mutex
	pages    map[uint64]*physPage
	snaps    map[uint64]*Snapshot
	nextPhys uint64
	nextSnap uint64
	allocs   uint64
	frees    uint64
	cows     uint64
}

// NewStore returns an empty page store.
func NewStore() *Store {
	return &Store{
		pages: make(map[uint64]*physPage),
		snaps: make(map[uint64]*Snapshot),
	}
}

// Snapshot is one branch of the page store: an independent logical view
// mapping logical page numbers to shared physical pages.
type Snapshot struct {
	store   *Store
	id      uint64
	parent  uint64            // 0 means no parent (root snapshot)
	mapping map[uint64]uint64 // logical page -> physical page id
	closed  bool
}

// NewSnapshot creates an empty root snapshot.
func (s *Store) NewSnapshot() *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextSnap++
	snap := &Snapshot{store: s, id: s.nextSnap, mapping: make(map[uint64]uint64)}
	s.snaps[snap.id] = snap
	return snap
}

// ID returns the snapshot's unique identifier.
func (snap *Snapshot) ID() uint64 { return snap.id }

// Parent returns the identifier of the snapshot this one was forked from,
// or 0 for a root snapshot.
func (snap *Snapshot) Parent() uint64 { return snap.parent }

// Fork creates a new branch sharing every page of snap. The fork is cheap:
// no page data is copied; reference counts are incremented instead.
func (snap *Snapshot) Fork() (*Snapshot, error) {
	s := snap.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.closed {
		return nil, ErrClosed
	}
	s.nextSnap++
	child := &Snapshot{
		store:   s,
		id:      s.nextSnap,
		parent:  snap.id,
		mapping: make(map[uint64]uint64, len(snap.mapping)),
	}
	for logical, phys := range snap.mapping {
		child.mapping[logical] = phys
		s.pages[phys].refs++
	}
	s.snaps[child.id] = child
	return child, nil
}

// Read returns a copy of the given logical page. Pages never written read
// back as all zeros.
func (snap *Snapshot) Read(logical uint64) ([]byte, error) {
	s := snap.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.closed {
		return nil, ErrClosed
	}
	out := make([]byte, PageSize)
	if phys, ok := snap.mapping[logical]; ok {
		copy(out, s.pages[phys].data[:])
	}
	return out, nil
}

// Write stores data at the start of the given logical page. Bytes beyond
// len(data) keep their previous contents (zeros for never-written pages),
// matching pwrite semantics. If the physical page is shared with other
// live branches, it is copied first (copy-on-write) so their views are
// unaffected.
func (snap *Snapshot) Write(logical uint64, data []byte) error {
	if len(data) > PageSize {
		return ErrOverflow
	}
	s := snap.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.closed {
		return ErrClosed
	}
	if phys, ok := snap.mapping[logical]; ok && s.pages[phys].refs == 1 {
		// Sole owner: write in place.
		p := s.pages[phys]
		copy(p.data[:], data)
		return nil
	}
	// Shared or unmapped: allocate a fresh private page.
	old, hadOld := snap.mapping[logical]
	np := &physPage{refs: 1}
	if hadOld {
		copy(np.data[:], s.pages[old].data[:])
		s.cows++
	}
	copy(np.data[:], data)
	s.nextPhys++
	s.pages[s.nextPhys] = np
	s.allocs++
	snap.mapping[logical] = s.nextPhys
	if hadOld {
		s.releaseLocked(old)
	}
	return nil
}

// Close releases the snapshot. Reference counts of all its pages are
// decremented; pages whose count reaches zero are reclaimed. Pages still
// referenced by other live snapshots are kept.
func (snap *Snapshot) Close() error {
	s := snap.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.closed {
		return ErrClosed
	}
	for _, phys := range snap.mapping {
		s.releaseLocked(phys)
	}
	snap.mapping = nil
	snap.closed = true
	delete(s.snaps, snap.id)
	return nil
}

// LogicalPages returns the sorted logical page numbers mapped by this
// snapshot. It is intended for diagnostics and verification.
func (snap *Snapshot) LogicalPages() ([]uint64, error) {
	s := snap.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if snap.closed {
		return nil, ErrClosed
	}
	out := make([]uint64, 0, len(snap.mapping))
	for logical := range snap.mapping {
		out = append(out, logical)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}

// releaseLocked decrements the reference count of a physical page and
// reclaims it when the last reference goes away. Caller holds s.mu.
func (s *Store) releaseLocked(phys uint64) {
	p := s.pages[phys]
	p.refs--
	if p.refs == 0 {
		delete(s.pages, phys)
		s.frees++
	}
}

// Stats returns a snapshot of the store's diagnostic counters.
func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	var total uint64
	for _, p := range s.pages {
		total += uint64(p.refs)
	}
	return Stats{
		LivePages:     uint64(len(s.pages)),
		LiveSnapshots: uint64(len(s.snaps)),
		TotalRefs:     total,
		Allocs:        s.allocs,
		Frees:         s.frees,
		CowCopies:     s.cows,
	}
}

// RefTable returns a copy of the physical-page reference table
// (physical page id -> reference count) for diagnostics.
func (s *Store) RefTable() map[uint64]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[uint64]int, len(s.pages))
	for id, p := range s.pages {
		out[id] = p.refs
	}
	return out
}

// VerifyRefCounts recomputes every physical page's reference count from
// the mappings of all live snapshots and reports any mismatch. A nil
// return means the reference table is exactly consistent.
func (s *Store) VerifyRefCounts() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := make(map[uint64]int)
	for _, snap := range s.snaps {
		for _, phys := range snap.mapping {
			want[phys]++
		}
	}
	for phys, n := range want {
		p, ok := s.pages[phys]
		if !ok {
			return fmt.Errorf("pagesnap: physical page %d referenced %d time(s) but already reclaimed", phys, n)
		}
		if p.refs != n {
			return fmt.Errorf("pagesnap: physical page %d has refs=%d, want %d", phys, p.refs, n)
		}
	}
	for phys, p := range s.pages {
		if want[phys] == 0 {
			return fmt.Errorf("pagesnap: physical page %d leaked with refs=%d but no live snapshot references it", phys, p.refs)
		}
		if p.refs <= 0 {
			return fmt.Errorf("pagesnap: physical page %d has non-positive refs=%d", phys, p.refs)
		}
	}
	return nil
}
