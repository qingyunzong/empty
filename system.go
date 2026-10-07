package conveyor

import (
	"fmt"
	"sort"
)

// Interface is a finite-capacity one-way transfer port from a slot on one
// belt to a slot on another (or the same) belt. Packages waiting inside the
// interface buffer are the cross-belt pending set.
type Interface struct {
	ID       int
	FromBelt int
	FromSlot int
	ToBelt   int
	ToSlot   int
	Capacity int // buffer capacity, must be >= 1

	buffer []Package
}

// BufferLen returns the number of packages pending inside the interface.
func (in *Interface) BufferLen() int { return len(in.buffer) }

// System is a set of belts connected by transfer interfaces.
type System struct {
	belts   []*Belt
	byID    map[int]*Belt
	ifaces  []*Interface
	outputs []Package
}

// NewSystem creates a system from the given belts and interfaces.
func NewSystem(belts []*Belt, ifaces []*Interface) *System {
	s := &System{belts: belts, byID: make(map[int]*Belt), ifaces: ifaces}
	for _, b := range belts {
		if _, dup := s.byID[b.id]; dup {
			panic(fmt.Sprintf("conveyor: duplicate belt id %d", b.id))
		}
		s.byID[b.id] = b
	}
	for _, in := range ifaces {
		if in.Capacity < 1 {
			panic("conveyor: interface capacity must be >= 1")
		}
		from, to := s.byID[in.FromBelt], s.byID[in.ToBelt]
		if from == nil || to == nil {
			panic("conveyor: interface references unknown belt")
		}
		if in.FromSlot < 0 || in.FromSlot >= from.size || in.ToSlot < 0 || in.ToSlot >= to.size {
			panic("conveyor: interface slot out of range")
		}
	}
	return s
}

// Belt returns the belt with the given id, or nil.
func (s *System) Belt(id int) *Belt { return s.byID[id] }

// Interfaces returns the transfer interfaces of the system.
func (s *System) Interfaces() []*Interface { return append([]*Interface(nil), s.ifaces...) }

// Inject enqueues a package on the named belt.
func (s *System) Inject(beltID int, p Package) {
	b := s.byID[beltID]
	if b == nil {
		panic(fmt.Sprintf("conveyor: unknown belt %d", beltID))
	}
	b.Inject(p)
}

// Outputs returns all packages removed so far, in removal order.
func (s *System) Outputs() []Package { return append([]Package(nil), s.outputs...) }

// Tick advances the whole system by one step: move, transfer (drain then
// fill), insert, remove. It returns the packages removed during this tick.
func (s *System) Tick() []Package {
	for _, b := range s.belts {
		b.move()
	}
	moved := s.drainInterfaces()
	s.fillInterfaces(moved)
	for _, b := range s.belts {
		b.insert()
	}
	before := len(s.outputs)
	for _, b := range s.belts {
		b.remove(&s.outputs)
	}
	return append([]Package(nil), s.outputs[before:]...)
}

// drainInterfaces moves at most one package per interface buffer head onto
// its target slot. Each target slot accepts at most one transfer per tick;
// competing packages are resolved by lowest package ID. It returns the IDs
// of packages placed by the drain.
func (s *System) drainInterfaces() map[int]bool {
	moved := make(map[int]bool)
	type cand struct {
		iface *Interface
		pkg   Package
	}
	byTarget := make(map[[2]int][]cand)
	var targets [][2]int
	for _, in := range s.ifaces {
		if len(in.buffer) == 0 {
			continue
		}
		key := [2]int{in.ToBelt, in.ToSlot}
		if _, seen := byTarget[key]; !seen {
			targets = append(targets, key)
		}
		byTarget[key] = append(byTarget[key], cand{in, in.buffer[0]})
	}
	sort.Slice(targets, func(i, j int) bool {
		if targets[i][0] != targets[j][0] {
			return targets[i][0] < targets[j][0]
		}
		return targets[i][1] < targets[j][1]
	})
	for _, key := range targets {
		cs := byTarget[key]
		best := 0
		for i := 1; i < len(cs); i++ {
			if cs[i].pkg.ID < cs[best].pkg.ID {
				best = i
			}
		}
		dst := s.byID[key[0]]
		if dst.slots[key[1]] != nil {
			continue // target occupied: nobody transfers
		}
		winner := cs[best]
		p := winner.iface.buffer[0]
		winner.iface.buffer = winner.iface.buffer[1:]
		dst.slots[key[1]] = &p
		moved[p.ID] = true
	}
	return moved
}

// fillInterfaces moves a package from an interface's source slot into its
// buffer when the package's destination belt matches the interface target
// belt, the buffer has room, and the package did not transfer this same
// tick (no duplicate transfers per tick).
func (s *System) fillInterfaces(moved map[int]bool) {
	for _, in := range s.ifaces {
		if len(in.buffer) >= in.Capacity {
			continue
		}
		src := s.byID[in.FromBelt]
		p := src.slots[in.FromSlot]
		if p == nil || p.DestBelt != in.ToBelt {
			continue
		}
		if moved[p.ID] {
			continue
		}
		in.buffer = append(in.buffer, *p)
		src.slots[in.FromSlot] = nil
	}
}

// Locations maps every live package ID to a human-readable unique location:
// a belt slot, a belt injection queue, an interface buffer, or the output.
// It is the reference for package conservation and unique-position checks.
func (s *System) Locations() map[int]string {
	loc := make(map[int]string)
	for _, b := range s.belts {
		for i, p := range b.slots {
			if p != nil {
				loc[p.ID] = fmt.Sprintf("belt %d slot %d", b.id, i)
			}
		}
		for i, p := range b.queue {
			loc[p.ID] = fmt.Sprintf("belt %d queue[%d]", b.id, i)
		}
	}
	for _, in := range s.ifaces {
		for i, p := range in.buffer {
			loc[p.ID] = fmt.Sprintf("interface %d buffer[%d]", in.ID, i)
		}
	}
	for i, p := range s.outputs {
		loc[p.ID] = fmt.Sprintf("output[%d]", i)
	}
	return loc
}

// VerifyConservation checks that every injected package ID appears in
// exactly one location and that the live set equals want.
func (s *System) VerifyConservation(want []int) error {
	loc := s.Locations()
	if len(loc) != len(want) {
		return fmt.Errorf("conveyor: conservation violated: %d packages live, want %d", len(loc), len(want))
	}
	for _, id := range want {
		if _, ok := loc[id]; !ok {
			return fmt.Errorf("conveyor: package %d missing", id)
		}
	}
	return nil
}
