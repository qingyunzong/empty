package main

// State is one vertex of the finite state graph: position, remaining integer
// fuel, the set of still-available one-time coupons (bitmask), the remaining
// charging slots of every station, and the current time.
type State struct {
	Node    int
	Fuel    int
	Coupons uint8 // bit i set => coupon i is still available
	Slots   [MaxStations]int
	Time    int
}

// Key packs a state into 30 bits:
//
//	node 4 | fuel 5 | coupons 6 | time 7 | slots 4x2
func (s State) Key() uint64 {
	k := uint64(s.Node)
	k |= uint64(s.Fuel) << 4
	k |= uint64(s.Coupons) << 9
	k |= uint64(s.Time) << 15
	for i := 0; i < MaxStations; i++ {
		k |= uint64(s.Slots[i]) << uint(22+2*i)
	}
	return k
}

func stateFromKey(k uint64) State {
	var s State
	s.Node = int(k & 0xF)
	s.Fuel = int((k >> 4) & 0x1F)
	s.Coupons = uint8((k >> 9) & 0x3F)
	s.Time = int((k >> 15) & 0x7F)
	for i := 0; i < MaxStations; i++ {
		s.Slots[i] = int((k >> uint(22+2*i)) & 0x3)
	}
	return s
}

// InitialState builds the start state: full tank, all coupons available, all
// charging slots free, time 0.
func (g *Graph) InitialState() State {
	s := State{
		Node:    g.Start,
		Fuel:    g.MaxFuel,
		Coupons: (1 << MaxCoupons) - 1,
		Time:    0,
	}
	for i, st := range g.Stations {
		s.Slots[i] = st.Capacity
	}
	return s
}

// Transition describes one edge of the state graph.
type Transition struct {
	Kind      string `json:"kind"` // "traverse" or "refuel"
	Edge      int    `json:"edge"`
	Station   int    `json:"station"`
	Amount    int    `json:"amount"` // fuel bought (refuel only)
	UseCoupon bool   `json:"useCoupon"`
	Cost      int    `json:"cost"`
}

// Succ pairs a successor state with the transition that produced it.
type Succ struct {
	Next State
	Tr   Transition
}

// Successors enumerates every legal one-step transition from s.
func (g *Graph) Successors(s State) []Succ {
	var out []Succ
	for i, e := range g.Edges {
		if e.From != s.Node || e.Fuel > s.Fuel {
			continue
		}
		dep, ok := g.earliestDepart(e.Windows, s.Time, e.Time)
		if !ok {
			continue
		}
		arr := dep + e.Time
		if arr > g.MaxTime {
			continue
		}
		next := s
		next.Node = e.To
		next.Fuel -= e.Fuel
		next.Time = arr
		// Option 1: do not spend the coupon.
		out = append(out, Succ{next, Transition{
			Kind: "traverse", Edge: i, Station: -1,
			Cost: g.TollPaid(e, s.Fuel, false),
		}})
		// Option 2: spend the one-time coupon if it is still available.
		// The bit is cleared, so the same coupon can never be used again,
		// in particular not on a return trip over the same edge.
		if e.Coupon >= 0 && s.Coupons&(1<<uint(e.Coupon)) != 0 {
			withCoupon := next
			withCoupon.Coupons &^= 1 << uint(e.Coupon)
			out = append(out, Succ{withCoupon, Transition{
				Kind: "traverse", Edge: i, Station: -1, UseCoupon: true,
				Cost: g.TollPaid(e, s.Fuel, true),
			}})
		}
	}
	// Refuel at a supply station: one charging slot per action.
	if si := g.stationAt(s.Node); si >= 0 && s.Slots[si] > 0 {
		st := g.Stations[si]
		for amount := 1; amount+s.Fuel <= g.MaxFuel; amount++ {
			dt := amount * st.RefuelTime
			if s.Time+dt > g.MaxTime {
				break
			}
			next := s
			next.Fuel += amount
			next.Time += dt
			next.Slots[si]--
			out = append(out, Succ{next, Transition{
				Kind: "refuel", Edge: -1, Station: si, Amount: amount,
				Cost: amount * st.Price,
			}})
		}
	}
	return out
}
