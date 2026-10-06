// Package conveyor implements a discrete-time simulation of ring conveyor
// belts: packages are injected into a ring of slots, move one slot per tick,
// and are extracted when they reach their destination port. Belts can be
// connected through capacity-limited transfer links, and the whole system
// supports snapshots and package-location verification.
package conveyor

import "fmt"

// Port identifies a single slot on a single belt.
type Port struct {
	Belt int
	Slot int
}

// Package is a unit travelling through the system. IDs must be unique across
// all packages ever injected; they are used for tie-breaking when several
// packages compete for the same transfer target in one tick.
type Package struct {
	ID   int
	Dest Port
}

// Belt is a ring of slots, each holding at most one package. Slot 0 is the
// injection port. A belt with any faulty slot is paused: it does not move,
// inject, extract, or participate in transfers.
type Belt struct {
	slots  []*Package
	queue  []Package
	faults []bool
}

// NewBelt creates a ring belt with size slots. It panics if size <= 0.
func NewBelt(size int) *Belt {
	if size <= 0 {
		panic("conveyor: belt size must be positive")
	}
	return &Belt{slots: make([]*Package, size), faults: make([]bool, size)}
}

// Len returns the number of slots on the belt.
func (b *Belt) Len() int { return len(b.slots) }

// Slot returns a copy of the package at slot i, or nil if the slot is empty.
func (b *Belt) Slot(i int) *Package {
	if i < 0 || i >= len(b.slots) {
		panic(fmt.Sprintf("conveyor: slot %d out of range [0,%d)", i, len(b.slots)))
	}
	if p := b.slots[i]; p != nil {
		cp := *p
		return &cp
	}
	return nil
}

// Enqueue appends a package to the injection queue. The package enters slot 0
// during a later inject phase, once that slot is free.
func (b *Belt) Enqueue(pkg Package) { b.queue = append(b.queue, pkg) }

// Queue returns a copy of the injection queue, head first.
func (b *Belt) Queue() []Package { return append([]Package(nil), b.queue...) }

// QueueLen returns the number of packages waiting to be injected.
func (b *Belt) QueueLen() int { return len(b.queue) }

// SetFault marks a slot as faulty (or clears the fault). Any faulty slot
// pauses the whole belt.
func (b *Belt) SetFault(slot int, on bool) {
	if slot < 0 || slot >= len(b.faults) {
		panic(fmt.Sprintf("conveyor: slot %d out of range [0,%d)", slot, len(b.faults)))
	}
	b.faults[slot] = on
}

// Fault reports whether the given slot is faulty.
func (b *Belt) Fault(slot int) bool {
	if slot < 0 || slot >= len(b.faults) {
		panic(fmt.Sprintf("conveyor: slot %d out of range [0,%d)", slot, len(b.faults)))
	}
	return b.faults[slot]
}

// Paused reports whether the belt has any faulty slot and is therefore paused.
func (b *Belt) Paused() bool {
	for _, f := range b.faults {
		if f {
			return true
		}
	}
	return false
}

// move rotates every package one slot forward (slot i -> slot i+1, wrapping
// from the last slot to slot 0). It is a no-op on a paused belt.
func (b *Belt) move() {
	next := make([]*Package, len(b.slots))
	for i, p := range b.slots {
		if p != nil {
			next[(i+1)%len(b.slots)] = p
		}
	}
	b.slots = next
}

// inject admits the head of the queue into slot 0 if it is empty.
func (b *Belt) inject() {
	if len(b.queue) > 0 && b.slots[0] == nil {
		pkg := b.queue[0]
		b.queue = b.queue[1:]
		b.slots[0] = &pkg
	}
}

// extract removes every package whose destination is (beltID, slot) from its
// slot and returns them in ascending slot order.
func (b *Belt) extract(beltID int) []Package {
	var out []Package
	for i, p := range b.slots {
		if p != nil && p.Dest.Belt == beltID && p.Dest.Slot == i {
			out = append(out, *p)
			b.slots[i] = nil
		}
	}
	return out
}

// Tick advances a standalone belt by one tick: move, then inject, then
// extract. A paused belt does nothing. It returns the extracted packages.
func (b *Belt) Tick() []Package {
	if b.Paused() {
		return nil
	}
	b.move()
	b.inject()
	return b.extract(0)
}
