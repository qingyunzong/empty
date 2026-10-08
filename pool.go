// Package genpool implements a fixed-capacity object pool that hands out
// generational handles (index + generation). A handle becomes stale as soon
// as its slot is released, so reused slots can never be accessed through an
// old handle. Slots whose generation counter overflows are retired
// permanently instead of wrapping around.
package genpool

import (
	"errors"
	"fmt"
	"sync"
)

// Handle identifies one borrow of a pool slot. It is only valid while the
// slot it points to is borrowed with the same generation.
type Handle struct {
	Index uint32
	Gen   uint32
}

func (h Handle) String() string {
	return fmt.Sprintf("Handle{idx:%d gen:%d}", h.Index, h.Gen)
}

type slotState uint8

const (
	stateFree slotState = iota
	stateBorrowed
	stateRetired
)

type slot[T any] struct {
	value T
	gen   uint32
	state slotState
}

// Pool is a fixed-capacity pool of T addressed by generational handles.
// The zero value is not usable; construct one with New.
type Pool[T any] struct {
	mu     sync.Mutex
	slots  []slot[T]
	free   []uint32 // stack of indices in stateFree
	maxGen uint32
}

// New builds a pool with capacity slots, each initialized by factory.
// genBits is the width of the generation counter (1..32). When a slot's
// generation would exceed 2^genBits-1 the slot is retired permanently.
func New[T any](factory func() T, capacity int, genBits uint) (*Pool[T], error) {
	if capacity < 0 {
		return nil, errors.New("genpool: negative capacity")
	}
	if genBits < 1 || genBits > 32 {
		return nil, fmt.Errorf("genpool: genBits %d out of range [1,32]", genBits)
	}
	p := &Pool[T]{
		slots:  make([]slot[T], capacity),
		free:   make([]uint32, 0, capacity),
		maxGen: uint32((uint64(1) << genBits) - 1),
	}
	for i := range p.slots {
		p.slots[i].value = factory()
		p.slots[i].gen = 1 // generation 0 is never issued, so the zero Handle is invalid
		p.free = append(p.free, uint32(i))
	}
	return p, nil
}

// Borrow takes one slot out of the pool. The second result is false when the
// pool is exhausted (all slots borrowed or retired).
func (p *Pool[T]) Borrow() (Handle, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.borrowLocked()
}

func (p *Pool[T]) borrowLocked() (Handle, bool) {
	n := len(p.free)
	if n == 0 {
		return Handle{}, false
	}
	idx := p.free[n-1]
	p.free = p.free[:n-1]
	s := &p.slots[idx]
	s.state = stateBorrowed
	return Handle{Index: idx, Gen: s.gen}, true
}

// BorrowN takes n slots out of the pool. It is all-or-nothing: if fewer than
// n slots are available, nothing is borrowed and ok is false.
func (p *Pool[T]) BorrowN(n int) (handles []Handle, ok bool) {
	if n < 0 {
		return nil, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if n > len(p.free) {
		return nil, false
	}
	handles = make([]Handle, 0, n)
	for i := 0; i < n; i++ {
		h, _ := p.borrowLocked()
		handles = append(handles, h)
	}
	return handles, true
}

// validLocked reports whether h currently addresses a borrowed slot.
func (p *Pool[T]) validLocked(h Handle) bool {
	if h.Index >= uint32(len(p.slots)) {
		return false
	}
	s := &p.slots[h.Index]
	return s.state == stateBorrowed && s.gen == h.Gen
}

// Get returns a pointer to the value behind h, or nil if h is stale,
// already released, retired, or out of range.
func (p *Pool[T]) Get(h Handle) (*T, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.validLocked(h) {
		return nil, false
	}
	return &p.slots[h.Index].value, true
}

// Release returns the slot behind h to the pool and bumps its generation, so
// h and any copy of it become stale. If the generation would overflow its
// bit width, the slot is retired permanently instead. It returns false when
// h is not a live handle (stale, double-released, retired, or out of range).
func (p *Pool[T]) Release(h Handle) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.validLocked(h) {
		return false
	}
	s := &p.slots[h.Index]
	if s.gen == p.maxGen {
		// Generation overflow: never reuse this slot again.
		s.state = stateRetired
		return true
	}
	s.gen++
	s.state = stateFree
	p.free = append(p.free, h.Index)
	return true
}

// Shrink retires up to n empty (free) slots, permanently removing them from
// the pool. Borrowed slots are never touched; they may be retired by a later
// Shrink once released. It returns how many slots were actually retired.
func (p *Pool[T]) Shrink(n int) int {
	if n <= 0 {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if n > len(p.free) {
		n = len(p.free)
	}
	for _, idx := range p.free[:n] {
		p.slots[idx].state = stateRetired
	}
	p.free = p.free[n:]
	return n
}

// Stats reports pool occupancy: total capacity, free, borrowed, and retired
// (permanently disabled) slot counts.
func (p *Pool[T]) Stats() (capacity, free, borrowed, retired int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	capacity = len(p.slots)
	free = len(p.free)
	for i := range p.slots {
		switch p.slots[i].state {
		case stateBorrowed:
			borrowed++
		case stateRetired:
			retired++
		}
	}
	return capacity, free, borrowed, retired
}
