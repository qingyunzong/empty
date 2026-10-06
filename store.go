// Package sampler implements a fixed-capacity store that keeps the latest N
// items, each identified by a stable, monotonically increasing sequence
// number. Snapshots pin the items visible at acquisition so they remain
// readable until released; writes that would overwrite a pinned item are
// rejected instead of dropping old data.
package sampler

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

var (
	// ErrFull is returned by Put when the store is at capacity and the
	// oldest item is pinned by an active snapshot. The old data is kept.
	ErrFull = errors.New("sampler: capacity exhausted and oldest item pinned by snapshot")
	// ErrSeqRegression is returned by Put when seq is not greater than the
	// latest sequence number already stored.
	ErrSeqRegression = errors.New("sampler: sequence number must increase")
)

// Item is a single stored sample.
type Item struct {
	Seq   uint64
	Value any
}

type slot struct {
	seq   uint64
	value any
}

// Store is a fixed-capacity ring buffer of items indexed by sequence number.
// Sequence numbers may have gaps; indexing does not depend on contiguity.
// It is safe for concurrent use.
type Store struct {
	mu      sync.Mutex
	slots   []slot
	head    int // slot index of the oldest item
	count   int
	last    uint64
	hasLast bool
	pins    map[uint64]int // pinned low-water seq -> active snapshot count
}

// New returns a Store holding at most capacity items.
func New(capacity int) *Store {
	if capacity <= 0 {
		panic("sampler: capacity must be positive")
	}
	return &Store{
		slots: make([]slot, capacity),
		pins:  make(map[uint64]int),
	}
}

// Capacity returns the maximum number of items the store holds.
func (s *Store) Capacity() int { return len(s.slots) }

// Len returns the number of items currently stored.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.count
}

// Put inserts value under seq. seq must be greater than every previously
// written sequence number; gaps are allowed. When the store is full the
// oldest item is evicted, unless it is pinned by a snapshot, in which case
// Put returns ErrFull and no data is dropped.
func (s *Store) Put(seq uint64, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hasLast && seq <= s.last {
		return fmt.Errorf("%w: got %d, latest is %d", ErrSeqRegression, seq, s.last)
	}
	if s.count == len(s.slots) {
		if s.protectedLocked(s.slots[s.head].seq) {
			return ErrFull
		}
		// Evict the oldest item by overwriting its slot.
		s.slots[s.head] = slot{seq: seq, value: value}
		s.head = (s.head + 1) % len(s.slots)
	} else {
		s.slots[(s.head+s.count)%len(s.slots)] = slot{seq: seq, value: value}
		s.count++
	}
	s.last = seq
	s.hasLast = true
	return nil
}

// Get returns the value stored under seq.
func (s *Store) Get(seq uint64) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getLocked(seq)
}

// Oldest returns the smallest sequence number currently stored.
func (s *Store) Oldest() (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.count == 0 {
		return 0, false
	}
	return s.slots[s.head].seq, true
}

// Latest returns the largest sequence number ever written.
func (s *Store) Latest() (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last, s.hasLast
}

// Items returns a snapshot-consistent copy of all stored items, oldest first.
func (s *Store) Items() []Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.itemsLocked(s.slots[s.head].seq, s.count)
}

// Acquire pins every item currently stored and returns a Snapshot that can
// read them until Release is called. It returns ok=false when the store is
// empty and there is nothing to pin.
func (s *Store) Acquire() (snap *Snapshot, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.count == 0 {
		return nil, false
	}
	return s.acquireLocked(s.slots[s.head].seq), true
}

// AcquireFrom pins all stored items with sequence number >= seq and returns
// a Snapshot over them. It returns ok=false when seq is no longer stored
// (already evicted or never written).
func (s *Store) AcquireFrom(seq uint64) (snap *Snapshot, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, found := s.getLocked(seq); !found {
		return nil, false
	}
	return s.acquireLocked(seq), true
}

func (s *Store) acquireLocked(pin uint64) *Snapshot {
	s.pins[pin]++
	return &Snapshot{store: s, pin: pin}
}

// protectedLocked reports whether an item with the given sequence number is
// covered by at least one active snapshot pin.
func (s *Store) protectedLocked(seq uint64) bool {
	for pin, n := range s.pins {
		if n > 0 && pin <= seq {
			return true
		}
	}
	return false
}

// getLocked locates seq by binary search over the ring in logical order.
// Sequence numbers are strictly increasing, so gaps do not affect indexing.
func (s *Store) getLocked(seq uint64) (any, bool) {
	lo, hi := 0, s.count
	for lo < hi {
		mid := (lo + hi) / 2
		if s.slots[(s.head+mid)%len(s.slots)].seq < seq {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < s.count {
		if sl := s.slots[(s.head+lo)%len(s.slots)]; sl.seq == seq {
			return sl.value, true
		}
	}
	return nil, false
}

// itemsLocked copies stored items with sequence number >= from, oldest first.
func (s *Store) itemsLocked(from uint64, limit int) []Item {
	out := make([]Item, 0, limit)
	for i := 0; i < s.count && len(out) < limit; i++ {
		sl := s.slots[(s.head+i)%len(s.slots)]
		if sl.seq >= from {
			out = append(out, Item{Seq: sl.seq, Value: sl.value})
		}
	}
	return out
}

// Snapshot pins the items that were stored at acquisition time, keeping them
// readable until Release. A Snapshot is not safe for concurrent use with its
// own Release.
type Snapshot struct {
	store    *Store
	pin      uint64
	released sync.Once
	done     atomic.Bool
}

// Pin returns the lowest sequence number guaranteed readable by this
// snapshot.
func (sn *Snapshot) Pin() uint64 { return sn.pin }

// Get returns the value stored under seq. It reports ok=false for sequences
// below the snapshot pin, even if they are somehow still stored.
func (sn *Snapshot) Get(seq uint64) (any, bool) {
	if seq < sn.pin {
		return nil, false
	}
	return sn.store.Get(seq)
}

// Items returns every item from the snapshot pin up to the latest write,
// oldest first. Pinned items remain available until Release.
func (sn *Snapshot) Items() []Item {
	sn.store.mu.Lock()
	defer sn.store.mu.Unlock()
	return sn.store.itemsLocked(sn.pin, sn.store.count)
}

// Released reports whether Release has been called.
func (sn *Snapshot) Released() bool {
	return sn.done.Load()
}

// Release unpins the snapshot's items, allowing them to be evicted by later
// writes. It is idempotent.
func (sn *Snapshot) Release() {
	sn.released.Do(func() {
		sn.done.Store(true)
		sn.store.mu.Lock()
		defer sn.store.mu.Unlock()
		if n := sn.store.pins[sn.pin]; n <= 1 {
			delete(sn.store.pins, sn.pin)
		} else {
			sn.store.pins[sn.pin] = n - 1
		}
	})
}
