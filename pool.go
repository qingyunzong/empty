// Package objpool implements a fixed-capacity object pool that hands out
// index+generation handles. A handle is only valid while its generation
// matches the slot's current generation, so a stale handle can never reach
// a reused slot.
package objpool

import "fmt"

// Handle identifies one borrow of a pool slot. It is a plain value and
// cheap to copy; it grants access only while the slot's generation matches.
type Handle struct {
	Index uint32
	Gen   uint32
}

func (h Handle) String() string { return fmt.Sprintf("slot=%d gen=%d", h.Index, h.Gen) }

type slotState uint8

const (
	slotFree slotState = iota
	slotBorrowed
	slotRetired // permanently out of service (shrunk or generation overflow)
)

type slot[T any] struct {
	value T
	gen   uint32
	state slotState
}

// Pool is a fixed-capacity object pool. It is not safe for concurrent use;
// guard it with a mutex if shared across goroutines.
type Pool[T any] struct {
	slots  []slot[T]
	free   []uint32 // stack of free slot indices
	maxGen uint32   // generations live in [1, maxGen]; exceeding it retires the slot
	alive  int      // slots not retired
}

// New creates a pool with the given capacity. genBits selects the width of
// the generation counter (1..31); a slot may be borrowed at most
// (1<<genBits)-1 times before it is permanently retired. Generations start
// at 1 so the zero Handle is never valid.
func New[T any](capacity int, genBits uint) *Pool[T] {
	if capacity < 0 {
		panic("objpool: negative capacity")
	}
	if genBits < 1 || genBits > 31 {
		panic("objpool: genBits out of range [1,31]")
	}
	p := &Pool[T]{
		slots:  make([]slot[T], capacity),
		free:   make([]uint32, 0, capacity),
		maxGen: 1<<genBits - 1,
		alive:  capacity,
	}
	for i := capacity - 1; i >= 0; i-- {
		p.slots[i].gen = 1
		p.free = append(p.free, uint32(i))
	}
	return p
}

// valid reports whether h currently grants access to its slot.
func (p *Pool[T]) valid(h Handle) bool {
	return h.Index < uint32(len(p.slots)) &&
		p.slots[h.Index].state == slotBorrowed &&
		p.slots[h.Index].gen == h.Gen
}

// Borrow takes one slot out of the pool. The second return value is false
// when no free slot remains.
func (p *Pool[T]) Borrow() (Handle, bool) {
	if len(p.free) == 0 {
		return Handle{}, false
	}
	idx := p.free[len(p.free)-1]
	p.free = p.free[:len(p.free)-1]
	p.slots[idx].state = slotBorrowed
	return Handle{Index: idx, Gen: p.slots[idx].gen}, true
}

// BorrowN takes n slots out of the pool. It is all-or-nothing: if fewer
// than n slots are available, nothing is borrowed and ok is false.
func (p *Pool[T]) BorrowN(n int) (handles []Handle, ok bool) {
	if n < 0 {
		return nil, false
	}
	if n > len(p.free) {
		return nil, false
	}
	handles = make([]Handle, n)
	for i := range handles {
		handles[i], _ = p.Borrow() // cannot fail: capacity checked above
	}
	return handles, true
}

// Get returns a pointer to the value stored in the slot for h, or nil if
// the handle is stale (released, retired, or never valid).
func (p *Pool[T]) Get(h Handle) (*T, bool) {
	if !p.valid(h) {
		return nil, false
	}
	return &p.slots[h.Index].value, true
}

// Release returns the slot for h to the pool and bumps its generation, so
// h and every earlier handle for that slot stop working immediately. If the
// generation would overflow the configured bit width, the slot is retired
// permanently instead of wrapping. Returns false for stale handles.
func (p *Pool[T]) Release(h Handle) bool {
	if !p.valid(h) {
		return false
	}
	s := &p.slots[h.Index]
	if s.gen == p.maxGen {
		p.retire(h.Index)
		return true
	}
	s.gen++
	s.state = slotFree
	p.free = append(p.free, h.Index)
	return true
}

// retire permanently removes a slot from service.
func (p *Pool[T]) retire(idx uint32) {
	s := &p.slots[idx]
	var zero T
	s.value = zero
	s.state = slotRetired
	p.alive--
}

// Shrink retires up to n free (unborrowed) slots, permanently removing them
// from the pool. Borrowed slots are never touched; they retire later on
// release if their generation overflows, otherwise they return to the free
// set. Returns the number of slots actually retired.
func (p *Pool[T]) Shrink(n int) int {
	if n <= 0 {
		return 0
	}
	kept := p.free[:0]
	retired := 0
	for _, idx := range p.free {
		if retired < n {
			p.retire(idx)
			retired++
		} else {
			kept = append(kept, idx)
		}
	}
	p.free = kept
	return retired
}

// Available reports how many slots can be borrowed right now.
func (p *Pool[T]) Available() int { return len(p.free) }

// Borrowed reports how many slots are currently checked out.
func (p *Pool[T]) Borrowed() int { return p.alive - len(p.free) }

// Retired reports how many slots have been permanently removed.
func (p *Pool[T]) Retired() int { return len(p.slots) - p.alive }

// Capacity reports the pool's original capacity.
func (p *Pool[T]) Capacity() int { return len(p.slots) }
