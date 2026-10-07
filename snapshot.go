package conveyor

// BeltSnapshot captures a belt's slots, injection queue and fault flags.
type BeltSnapshot struct {
	ID       int
	Size     int
	InsertAt int
	Slots    map[int]Package // occupied slots only
	Queue    []Package
	Faulty   []int
}

// InterfaceSnapshot captures an interface's wiring and pending buffer.
type InterfaceSnapshot struct {
	ID       int
	FromBelt int
	FromSlot int
	ToBelt   int
	ToSlot   int
	Capacity int
	Buffer   []Package
}

// Snapshot captures the full system state: belt positions, queues, faults,
// cross-belt pending transfers and everything removed so far.
type Snapshot struct {
	Belts   []BeltSnapshot
	Ifaces  []InterfaceSnapshot
	Outputs []Package
}

// Snapshot returns a deep copy of the system state.
func (s *System) Snapshot() Snapshot {
	snap := Snapshot{Outputs: append([]Package(nil), s.outputs...)}
	for _, b := range s.belts {
		bs := BeltSnapshot{
			ID:       b.id,
			Size:     b.size,
			InsertAt: b.insertAt,
			Slots:    make(map[int]Package),
			Queue:    append([]Package(nil), b.queue...),
		}
		for i, p := range b.slots {
			if p != nil {
				bs.Slots[i] = *p
			}
		}
		for f := range b.faulty {
			bs.Faulty = append(bs.Faulty, f)
		}
		snap.Belts = append(snap.Belts, bs)
	}
	for _, in := range s.ifaces {
		snap.Ifaces = append(snap.Ifaces, InterfaceSnapshot{
			ID:       in.ID,
			FromBelt: in.FromBelt,
			FromSlot: in.FromSlot,
			ToBelt:   in.ToBelt,
			ToSlot:   in.ToSlot,
			Capacity: in.Capacity,
			Buffer:   append([]Package(nil), in.buffer...),
		})
	}
	return snap
}

// Restore rebuilds a system from a snapshot.
func Restore(snap Snapshot) *System {
	belts := make([]*Belt, 0, len(snap.Belts))
	for _, bs := range snap.Belts {
		b := NewBelt(bs.ID, bs.Size, bs.InsertAt)
		for i, p := range bs.Slots {
			p := p
			b.slots[i] = &p
		}
		b.queue = append([]Package(nil), bs.Queue...)
		for _, f := range bs.Faulty {
			b.faulty[f] = true
		}
		belts = append(belts, b)
	}
	ifaces := make([]*Interface, 0, len(snap.Ifaces))
	for _, is := range snap.Ifaces {
		ifaces = append(ifaces, &Interface{
			ID:       is.ID,
			FromBelt: is.FromBelt,
			FromSlot: is.FromSlot,
			ToBelt:   is.ToBelt,
			ToSlot:   is.ToSlot,
			Capacity: is.Capacity,
			buffer:   append([]Package(nil), is.Buffer...),
		})
	}
	s := NewSystem(belts, ifaces)
	s.outputs = append([]Package(nil), snap.Outputs...)
	return s
}
