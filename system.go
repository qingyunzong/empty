package conveyor

import (
	"fmt"
	"sort"
)

// TransferLink connects a source port to a target port on another (or the
// same) belt. A package sitting at the source slot whose destination belt
// differs from the belt it currently rides is diverted through the link: it
// moves to the target slot if that slot is empty, otherwise it waits in the
// link's pending buffer (up to Capacity packages). With Capacity 0 a blocked
// package simply stays on its belt and recirculates. Each link carries at
// most one package per tick, and a package never transfers twice in the same
// tick, so crossing several belts takes several ticks.
type TransferLink struct {
	From     Port
	To       Port
	Capacity int
}

type link struct {
	from, to Port
	capacity int
	pending  []Package
}

// System is a set of belts connected by transfer links, simulated in
// lock-step ticks.
type System struct {
	belts   []*Belt
	links   []*link
	outputs []Package
	tick    int
}

// NewSystem creates a system with one belt per given size.
func NewSystem(sizes ...int) *System {
	belts := make([]*Belt, len(sizes))
	for i, n := range sizes {
		belts[i] = NewBelt(n)
	}
	return &System{belts: belts}
}

// NumBelts returns the number of belts in the system.
func (s *System) NumBelts() int { return len(s.belts) }

// Belt returns the i-th belt.
func (s *System) Belt(i int) *Belt {
	if i < 0 || i >= len(s.belts) {
		panic(fmt.Sprintf("conveyor: belt %d out of range [0,%d)", i, len(s.belts)))
	}
	return s.belts[i]
}

// AddLink registers a transfer link. It returns an error if a port is out of
// range or the capacity is negative.
func (s *System) AddLink(l TransferLink) error {
	if l.Capacity < 0 {
		return fmt.Errorf("conveyor: negative link capacity %d", l.Capacity)
	}
	if err := s.checkPort(l.From); err != nil {
		return err
	}
	if err := s.checkPort(l.To); err != nil {
		return err
	}
	s.links = append(s.links, &link{from: l.From, to: l.To, capacity: l.Capacity})
	return nil
}

func (s *System) checkPort(p Port) error {
	if p.Belt < 0 || p.Belt >= len(s.belts) {
		return fmt.Errorf("conveyor: port %+v: unknown belt", p)
	}
	if p.Slot < 0 || p.Slot >= s.belts[p.Belt].Len() {
		return fmt.Errorf("conveyor: port %+v: slot out of range", p)
	}
	return nil
}

// Inject enqueues a package on the given belt.
func (s *System) Inject(belt int, pkg Package) { s.Belt(belt).Enqueue(pkg) }

// PendingCount returns the number of packages waiting in a link's buffer.
func (s *System) PendingCount(linkIdx int) int {
	if linkIdx < 0 || linkIdx >= len(s.links) {
		panic(fmt.Sprintf("conveyor: link %d out of range [0,%d)", linkIdx, len(s.links)))
	}
	return len(s.links[linkIdx].pending)
}

// Outputs returns all packages extracted so far, in extraction order.
func (s *System) Outputs() []Package { return append([]Package(nil), s.outputs...) }

// TickCount returns the number of ticks elapsed.
func (s *System) TickCount() int { return s.tick }

// Tick advances the whole system by one tick, in phases:
//  1. move: every non-paused belt rotates one slot;
//  2. transfer: links divert packages between belts (see TransferLink);
//  3. inject: every non-paused belt admits one queued package into slot 0;
//  4. extract: packages at their destination port leave the system.
//
// A paused (faulty) belt skips all phases but does not stop other belts.
func (s *System) Tick() {
	for _, b := range s.belts {
		if !b.Paused() {
			b.move()
		}
	}
	s.transfers()
	for _, b := range s.belts {
		if !b.Paused() {
			b.inject()
		}
	}
	for i, b := range s.belts {
		if b.Paused() {
			continue
		}
		s.outputs = append(s.outputs, b.extract(i)...)
	}
	s.tick++
}

// transferCandidate is one package offered by one link during a tick.
type transferCandidate struct {
	pkg         Package
	linkIdx     int
	fromPending bool
}

// transfers resolves all link transfers for the current tick. Candidates are
// gathered in a single pass before any package moves, so a package can never
// transfer twice in one tick. When several links target the same port, the
// smallest package ID wins; losers from a belt slot divert into their link's
// pending buffer if it has spare capacity, otherwise they stay on the belt.
func (s *System) transfers() {
	groups := make(map[Port][]transferCandidate)
	var ports []Port
	for li, l := range s.links {
		if s.belts[l.from.Belt].Paused() || s.belts[l.to.Belt].Paused() {
			continue // a paused belt neither sends nor receives
		}
		var c transferCandidate
		if len(l.pending) > 0 {
			c = transferCandidate{pkg: l.pending[0], linkIdx: li, fromPending: true}
		} else if p := s.belts[l.from.Belt].slots[l.from.Slot]; p != nil && p.Dest.Belt != l.from.Belt {
			c = transferCandidate{pkg: *p, linkIdx: li}
		} else {
			continue
		}
		if _, ok := groups[l.to]; !ok {
			ports = append(ports, l.to)
		}
		groups[l.to] = append(groups[l.to], c)
	}
	if len(ports) == 0 {
		return
	}
	sort.Slice(ports, func(i, j int) bool {
		if ports[i].Belt != ports[j].Belt {
			return ports[i].Belt < ports[j].Belt
		}
		return ports[i].Slot < ports[j].Slot
	})
	byID := func(g []transferCandidate) {
		sort.Slice(g, func(i, j int) bool {
			if g[i].pkg.ID != g[j].pkg.ID {
				return g[i].pkg.ID < g[j].pkg.ID
			}
			return g[i].linkIdx < g[j].linkIdx
		})
	}
	var winners, losers []transferCandidate
	for _, port := range ports {
		g := groups[port]
		byID(g)
		if s.belts[port.Belt].slots[port.Slot] == nil {
			winners = append(winners, g[0])
			losers = append(losers, g[1:]...)
		} else {
			losers = append(losers, g...)
		}
	}
	byID(winners)
	byID(losers)
	for _, w := range winners {
		l := s.links[w.linkIdx]
		if w.fromPending {
			l.pending = l.pending[1:]
		} else {
			slot := &s.belts[l.from.Belt].slots[l.from.Slot]
			if *slot == nil || (*slot).ID != w.pkg.ID {
				continue // already moved by another link sharing the source slot
			}
			*slot = nil
		}
		pkg := w.pkg
		s.belts[l.to.Belt].slots[l.to.Slot] = &pkg
	}
	for _, c := range losers {
		if c.fromPending {
			continue // stays buffered
		}
		l := s.links[c.linkIdx]
		if len(l.pending) >= l.capacity {
			continue // no buffer space: package recirculates on its belt
		}
		slot := &s.belts[l.from.Belt].slots[l.from.Slot]
		if *slot == nil || (*slot).ID != c.pkg.ID {
			continue
		}
		*slot = nil
		l.pending = append(l.pending, c.pkg)
	}
}

// Locations maps every package ID currently tracked by the system (on belts,
// in injection queues, in link buffers, or already extracted) to a
// human-readable location. It returns an error if any package ID appears in
// more than one place.
func (s *System) Locations() (map[int]string, error) {
	loc := make(map[int]string)
	add := func(id int, where string) error {
		if prev, dup := loc[id]; dup {
			return fmt.Errorf("conveyor: package %d found in two places: %s and %s", id, prev, where)
		}
		loc[id] = where
		return nil
	}
	for i, b := range s.belts {
		for j, p := range b.slots {
			if p != nil {
				if err := add(p.ID, fmt.Sprintf("belt %d slot %d", i, j)); err != nil {
					return nil, err
				}
			}
		}
		for k, p := range b.queue {
			if err := add(p.ID, fmt.Sprintf("belt %d inject queue position %d", i, k)); err != nil {
				return nil, err
			}
		}
	}
	for i, l := range s.links {
		for k, p := range l.pending {
			if err := add(p.ID, fmt.Sprintf("link %d pending buffer position %d", i, k)); err != nil {
				return nil, err
			}
		}
	}
	for k, p := range s.outputs {
		if err := add(p.ID, fmt.Sprintf("output position %d", k)); err != nil {
			return nil, err
		}
	}
	return loc, nil
}

// BeltState is the restorable state of one belt.
type BeltState struct {
	Slots  []*Package // nil entries are empty slots
	Queue  []Package
	Faults []bool
}

// LinkState is the restorable state of one transfer link.
type LinkState struct {
	Pending []Package
}

// Snapshot captures the full system state: belt contents, injection queues,
// faults, cross-belt pending transfers, outputs, and the tick counter.
type Snapshot struct {
	Tick    int
	Belts   []BeltState
	Links   []LinkState
	Outputs []Package
}

// Snapshot returns a deep copy of the current system state.
func (s *System) Snapshot() Snapshot {
	snap := Snapshot{Tick: s.tick}
	for _, b := range s.belts {
		bs := BeltState{
			Slots:  make([]*Package, len(b.slots)),
			Queue:  append([]Package(nil), b.queue...),
			Faults: append([]bool(nil), b.faults...),
		}
		for i, p := range b.slots {
			if p != nil {
				cp := *p
				bs.Slots[i] = &cp
			}
		}
		snap.Belts = append(snap.Belts, bs)
	}
	for _, l := range s.links {
		snap.Links = append(snap.Links, LinkState{Pending: append([]Package(nil), l.pending...)})
	}
	snap.Outputs = append([]Package(nil), s.outputs...)
	return snap
}

// Restore replaces the system state with a snapshot. It returns an error and
// leaves the system untouched if the snapshot shape does not match the
// system (belt count, belt sizes, link count).
func (s *System) Restore(snap Snapshot) error {
	if len(snap.Belts) != len(s.belts) {
		return fmt.Errorf("conveyor: snapshot has %d belts, system has %d", len(snap.Belts), len(s.belts))
	}
	for i := range s.belts {
		if len(snap.Belts[i].Slots) != len(s.belts[i].slots) {
			return fmt.Errorf("conveyor: snapshot belt %d has %d slots, system has %d",
				i, len(snap.Belts[i].Slots), len(s.belts[i].slots))
		}
	}
	if len(snap.Links) != len(s.links) {
		return fmt.Errorf("conveyor: snapshot has %d links, system has %d", len(snap.Links), len(s.links))
	}
	for i, b := range s.belts {
		bs := snap.Belts[i]
		for j, p := range bs.Slots {
			if p == nil {
				b.slots[j] = nil
			} else {
				cp := *p
				b.slots[j] = &cp
			}
		}
		b.queue = append([]Package(nil), bs.Queue...)
		b.faults = append([]bool(nil), bs.Faults...)
	}
	for i, l := range s.links {
		l.pending = append([]Package(nil), snap.Links[i].Pending...)
	}
	s.outputs = append([]Package(nil), snap.Outputs...)
	s.tick = snap.Tick
	return nil
}
