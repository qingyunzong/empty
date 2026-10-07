// Package conveyor simulates circular conveyor belts with per-slot capacity
// one, queued injection, destination-based removal, fault pausing, and
// multi-belt transfer interfaces with snapshot/restore support.
package conveyor

import "fmt"

// Package is a parcel travelling on the belts. IDs must be unique across the
// whole system. DestBelt/DestSlot name the output port where the package is
// removed from the system.
type Package struct {
	ID       int
	DestBelt int
	DestSlot int
}

// Belt is a circular conveyor with size slots. Slot capacity is one package.
type Belt struct {
	id       int
	size     int
	slots    []*Package
	insertAt int
	queue    []Package // FIFO of packages waiting for a free insert slot
	faulty   map[int]bool
}

// NewBelt creates a belt with the given id, size slots, and an injection
// port at slot insertAt.
func NewBelt(id, size, insertAt int) *Belt {
	if size <= 0 {
		panic("conveyor: belt size must be positive")
	}
	if insertAt < 0 || insertAt >= size {
		panic("conveyor: insert slot out of range")
	}
	return &Belt{
		id:       id,
		size:     size,
		slots:    make([]*Package, size),
		insertAt: insertAt,
		faulty:   make(map[int]bool),
	}
}

// ID returns the belt id.
func (b *Belt) ID() int { return b.id }

// Size returns the number of slots.
func (b *Belt) Size() int { return b.size }

// SetFault marks or clears a slot as faulty. While any slot of a belt is
// faulty the belt does not move (the whole belt pauses); injection, removal
// and transfers still operate.
func (b *Belt) SetFault(slot int, on bool) {
	if slot < 0 || slot >= b.size {
		panic("conveyor: fault slot out of range")
	}
	if on {
		b.faulty[slot] = true
	} else {
		delete(b.faulty, slot)
	}
}

// Paused reports whether the belt is halted by a faulty slot.
func (b *Belt) Paused() bool { return len(b.faulty) > 0 }

// Inject enqueues a package for this belt. If the insert slot is blocked the
// package waits in the FIFO queue.
func (b *Belt) Inject(p Package) { b.queue = append(b.queue, p) }

// Slot returns the package at slot i, or nil.
func (b *Belt) Slot(i int) *Package {
	if i < 0 || i >= b.size {
		panic("conveyor: slot out of range")
	}
	return b.slots[i]
}

// QueueLen returns the number of packages waiting to be inserted.
func (b *Belt) QueueLen() int { return len(b.queue) }

// move rotates every package one slot forward, unless the belt is paused.
func (b *Belt) move() {
	if b.Paused() {
		return
	}
	next := make([]*Package, b.size)
	for i, p := range b.slots {
		if p != nil {
			next[(i+1)%b.size] = p
		}
	}
	b.slots = next
}

// insert moves the head of the queue into the insert slot if it is empty.
func (b *Belt) insert() {
	if len(b.queue) == 0 || b.slots[b.insertAt] != nil {
		return
	}
	p := b.queue[0]
	b.queue = b.queue[1:]
	b.slots[b.insertAt] = &p
}

// remove takes out every package that has reached its destination port on
// this belt, appending it to out in ascending slot order.
func (b *Belt) remove(out *[]Package) {
	for i, p := range b.slots {
		if p != nil && p.DestBelt == b.id && p.DestSlot == i {
			*out = append(*out, *p)
			b.slots[i] = nil
		}
	}
}

func (b *Belt) String() string {
	s := ""
	for i, p := range b.slots {
		if p == nil {
			s += " ."
		} else {
			s += fmt.Sprintf(" %d", p.ID)
		}
		_ = i
	}
	return s
}
