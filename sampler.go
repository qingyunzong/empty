// Package sampler implements a fixed-capacity sampling buffer that retains
// the newest N items. Every item carries a stable, monotonically increasing
// sequence number; gaps in the sequence do not affect indexing. Snapshots
// pin the items visible at acquisition so they remain readable until the
// snapshot is released. A write that would overwrite a pinned item is
// rejected with ErrCapacity instead of silently dropping old data.
package sampler

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrCapacity is returned by writes when the buffer is full and the
	// oldest item is still pinned by a snapshot.
	ErrCapacity = errors.New("sampler: write rejected, oldest item pinned by snapshot")
	// ErrNotFound is returned when no item exists for a sequence number.
	ErrNotFound = errors.New("sampler: sequence not found")
	// ErrStaleSeq is returned when a sequence number is not greater than
	// the last one written.
	ErrStaleSeq = errors.New("sampler: sequence must be greater than the last written")
	// ErrReleased is returned when reading from a released snapshot.
	ErrReleased = errors.New("sampler: snapshot already released")
)

type entry struct {
	seq   int64
	value any
}

// Buffer is a fixed-capacity ring of the newest items. It is safe for
// concurrent use.
type Buffer struct {
	mu      sync.RWMutex
	slots   []entry
	head    int // slot index of the oldest entry
	size    int
	pins    map[int64]int // seq -> active snapshot pin count
	lastSeq int64
	started bool
}

// New returns a Buffer that retains at most capacity items.
func New(capacity int) *Buffer {
	if capacity <= 0 {
		panic(fmt.Sprintf("sampler: capacity must be positive, got %d", capacity))
	}
	return &Buffer{
		slots: make([]entry, capacity),
		pins:  make(map[int64]int),
	}
}

// Capacity returns the maximum number of retained items.
func (b *Buffer) Capacity() int { return len(b.slots) }

// Len returns the number of items currently retained.
func (b *Buffer) Len() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.size
}

// Append writes v with the next consecutive sequence number.
func (b *Buffer) Append(v any) error {
	b.mu.Lock()
	seq := b.lastSeq + 1
	if !b.started {
		seq = 1
	}
	err := b.writeLocked(seq, v)
	b.mu.Unlock()
	return err
}

// AppendAt writes v with an explicit sequence number, which must be greater
// than the last one written. Gaps are allowed and do not affect indexing.
func (b *Buffer) AppendAt(seq int64, v any) error {
	b.mu.Lock()
	err := b.writeLocked(seq, v)
	b.mu.Unlock()
	return err
}

func (b *Buffer) writeLocked(seq int64, v any) error {
	if b.started && seq <= b.lastSeq {
		return ErrStaleSeq
	}
	if b.size == len(b.slots) {
		oldest := b.slots[b.head]
		if b.pins[oldest.seq] > 0 {
			return ErrCapacity
		}
		// Evict the oldest slot in place and wrap the head forward.
		b.slots[b.head] = entry{seq: seq, value: v}
		b.head = (b.head + 1) % len(b.slots)
	} else {
		b.slots[(b.head+b.size)%len(b.slots)] = entry{seq: seq, value: v}
		b.size++
	}
	b.lastSeq = seq
	b.started = true
	return nil
}

// Get returns the item with the given sequence number.
func (b *Buffer) Get(seq int64) (any, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	i := b.indexOfLocked(seq)
	if i < 0 {
		return nil, ErrNotFound
	}
	return b.slots[i].value, nil
}

// At returns the sequence number and value of the i-th oldest retained item.
func (b *Buffer) At(i int) (int64, any, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if i < 0 || i >= b.size {
		return 0, nil, ErrNotFound
	}
	e := b.slots[(b.head+i)%len(b.slots)]
	return e.seq, e.value, nil
}

// Range calls fn for every retained item, oldest first, until fn returns false.
func (b *Buffer) Range(fn func(seq int64, v any) bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for i := 0; i < b.size; i++ {
		e := b.slots[(b.head+i)%len(b.slots)]
		if !fn(e.seq, e.value) {
			return
		}
	}
}

// indexOfLocked maps a sequence number to a slot index via binary search
// over the ring in logical (oldest-first) order. Sequence gaps are fine
// because lookup never relies on modular arithmetic on the sequence itself.
func (b *Buffer) indexOfLocked(seq int64) int {
	i := sort.Search(b.size, func(i int) bool {
		return b.slots[(b.head+i)%len(b.slots)].seq >= seq
	})
	if i < b.size && b.slots[(b.head+i)%len(b.slots)].seq == seq {
		return (b.head + i) % len(b.slots)
	}
	return -1
}

// Snapshot returns a read-only view of the items retained right now. Those
// items are pinned: writes that would overwrite them are rejected with
// ErrCapacity until Release is called.
type Snapshot struct {
	buf      *Buffer
	seqs     []int64
	mu       sync.Mutex
	released bool
}

// Snapshot captures and pins the currently retained items.
func (b *Buffer) Snapshot() *Snapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &Snapshot{buf: b, seqs: make([]int64, 0, b.size)}
	for i := 0; i < b.size; i++ {
		e := b.slots[(b.head+i)%len(b.slots)]
		b.pins[e.seq]++
		s.seqs = append(s.seqs, e.seq)
	}
	return s
}

// Len returns the number of items captured by the snapshot.
func (s *Snapshot) Len() int { return len(s.seqs) }

// Seqs returns the captured sequence numbers, oldest first.
func (s *Snapshot) Seqs() []int64 {
	out := make([]int64, len(s.seqs))
	copy(out, s.seqs)
	return out
}

// Get returns the captured item with the given sequence number. Pinned items
// stay readable until Release, even if the buffer has since filled up.
func (s *Snapshot) Get(seq int64) (any, error) {
	s.mu.Lock()
	released := s.released
	s.mu.Unlock()
	if released {
		return nil, ErrReleased
	}
	i := sort.Search(len(s.seqs), func(i int) bool { return s.seqs[i] >= seq })
	if i >= len(s.seqs) || s.seqs[i] != seq {
		return nil, ErrNotFound
	}
	return s.buf.Get(seq)
}

// At returns the sequence number and value of the i-th oldest captured item.
func (s *Snapshot) At(i int) (int64, any, error) {
	if i < 0 || i >= len(s.seqs) {
		return 0, nil, ErrNotFound
	}
	v, err := s.Get(s.seqs[i])
	if err != nil {
		return 0, nil, err
	}
	return s.seqs[i], v, nil
}

// Range calls fn for every captured item, oldest first, until fn returns false.
func (s *Snapshot) Range(fn func(seq int64, v any) bool) {
	for _, seq := range s.seqs {
		v, err := s.Get(seq)
		if err != nil {
			return
		}
		if !fn(seq, v) {
			return
		}
	}
}

// Release unpins the captured items. It is idempotent; reads after Release
// fail with ErrReleased.
func (s *Snapshot) Release() {
	s.mu.Lock()
	if s.released {
		s.mu.Unlock()
		return
	}
	s.released = true
	s.mu.Unlock()

	b := s.buf
	b.mu.Lock()
	for _, seq := range s.seqs {
		if n := b.pins[seq]; n <= 1 {
			delete(b.pins, seq)
		} else {
			b.pins[seq] = n - 1
		}
	}
	b.mu.Unlock()
}
