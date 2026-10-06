// Package pagestore implements a copy-on-write page store with MVCC.
//
// Writes happen in transactions. A transaction buffers a draft in memory;
// pages (and thus quota) are only consumed at commit time. Committing
// atomically switches the root version: readers that pinned an older
// version keep reading old pages, and superseded pages are recycled back
// into the free pool only after the last reader of a version releases it.
// If quota is insufficient or the durable backend fails, the commit is
// rejected, all reservations are rolled back, and the draft stays intact
// so the transaction can be retried.
package pagestore

import (
	"errors"
	"sync"
)

// ErrQuotaExceeded is returned by Commit when the store does not have
// enough free pages for the transaction's writes. The draft is preserved.
var ErrQuotaExceeded = errors.New("pagestore: insufficient page quota")

// PageID identifies a physical page in the store.
type PageID uint64

// Stats reports quota accounting. Invariant: Free + Used == Capacity.
type Stats struct {
	Capacity int // total pages the store may ever hold
	Free     int // pages available for new allocations
	Used     int // pages referenced by the root or a pinned version
	Versions int // live versions: current root plus reader-pinned versions
}

// version is an immutable committed snapshot: a directory from logical
// key to the page holding its value.
type version struct {
	num uint64
	dir map[string]PageID
}

// Store is a copy-on-write page store with a fixed page capacity.
type Store struct {
	mu      sync.RWMutex
	backend Backend

	capacity int
	free     int
	nextPage PageID

	root     *version          // current committed version
	holders  map[*version]int  // root hold + reader pins per version
	pageRefs map[PageID]int    // references from all live versions
	data     map[PageID][]byte // committed page contents
}

// NewStore creates a store with the given page capacity, persisting
// committed pages and roots through backend.
func NewStore(backend Backend, capacity int) *Store {
	root := &version{num: 0, dir: map[string]PageID{}}
	return &Store{
		backend:  backend,
		capacity: capacity,
		free:     capacity,
		nextPage: 1,
		root:     root,
		holders:  map[*version]int{root: 1},
		pageRefs: map[PageID]int{},
		data:     map[PageID][]byte{},
	}
}

// Stats returns the current quota accounting.
func (s *Store) Stats() Stats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Stats{
		Capacity: s.capacity,
		Free:     s.free,
		Used:     len(s.pageRefs),
		Versions: len(s.holders),
	}
}

// commit applies tx's draft as a new root version. On any failure the
// quota reservation is rolled back, the root is left untouched, and the
// caller's draft remains usable.
func (s *Store) commit(tx *Tx) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	needed := len(tx.writes)
	if needed > s.free {
		return ErrQuotaExceeded
	}
	s.free -= needed

	pages := make(map[PageID][]byte, needed)
	ids := make(map[string]PageID, needed)
	for key, val := range tx.writes {
		id := s.nextPage
		s.nextPage++
		ids[key] = id
		pages[id] = val
	}
	if err := s.backend.WritePages(pages); err != nil {
		s.free += needed
		return err
	}

	parent := s.root
	dir := make(map[string]PageID, len(parent.dir)+len(ids))
	for key, id := range parent.dir {
		dir[key] = id
	}
	for key := range tx.deletes {
		delete(dir, key)
	}
	for key, id := range ids {
		dir[key] = id
	}
	next := &version{num: parent.num + 1, dir: dir}

	if err := s.backend.WriteRoot(next.num); err != nil {
		// Pages may be durably orphaned in the backend, but no quota
		// is consumed and the in-memory root never moved.
		s.free += needed
		return err
	}

	// Publish: install page data, account references, switch the root
	// atomically under the lock, then drop this commit's hold on the
	// parent version (recycling its pages if no reader pins it).
	for id, val := range pages {
		s.data[id] = val
	}
	for _, id := range dir {
		s.pageRefs[id]++
	}
	s.root = next
	s.holders[next] = 1
	s.unhold(parent)
	return nil
}

// unhold drops one hold on v and recycles v's pages once its last hold
// is gone. Callers must hold s.mu. The current root always carries one
// hold, so it can never be recycled from under readers.
func (s *Store) unhold(v *version) {
	s.holders[v]--
	if s.holders[v] > 0 {
		return
	}
	delete(s.holders, v)
	for _, id := range v.dir {
		s.pageRefs[id]--
		if s.pageRefs[id] == 0 {
			delete(s.pageRefs, id)
			delete(s.data, id)
			s.free++
		}
	}
}
