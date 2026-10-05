package main

import "fmt"

// State is a node in the finite state graph. Every action strictly
// increases Time, so the state graph is acyclic.
type State struct {
	Node int `json:"node"`
	Fuel int `json:"fuel"`
	Mask int `json:"mask"` // bit i set => coupon i already spent
	Time int `json:"time"`
}

func (s State) Key() string {
	return fmt.Sprintf("%d|%d|%d|%d", s.Node, s.Fuel, s.Mask, s.Time)
}

// ParseState is the inverse of State.Key.
func ParseState(key string) (State, error) {
	var s State
	if _, err := fmt.Sscanf(key, "%d|%d|%d|%d", &s.Node, &s.Fuel, &s.Mask, &s.Time); err != nil {
		return State{}, fmt.Errorf("bad state key %q: %w", key, err)
	}
	return s, nil
}

func stateLess(a, b State) bool {
	if a.Node != b.Node {
		return a.Node < b.Node
	}
	if a.Fuel != b.Fuel {
		return a.Fuel < b.Fuel
	}
	if a.Mask != b.Mask {
		return a.Mask < b.Mask
	}
	return a.Time < b.Time
}

// Action is one transition in the state graph.
type Action struct {
	Kind   string `json:"kind"` // "drive", "discount", "refuel", "wait"
	Edge   int    `json:"edge"` // edge index for drive/discount, else -1
	Depart int    `json:"depart"`
	Arrive int    `json:"arrive"`
	Cost   int    `json:"cost"`
	Next   State  `json:"next"`
}

// earliestDepart returns the earliest departure time >= t inside any
// window, or -1 if no window is reachable. No windows means always open.
func earliestDepart(t int, ws []Window) int {
	if len(ws) == 0 {
		return t
	}
	best := -1
	for _, w := range ws {
		if t > w.End {
			continue
		}
		d := t
		if d < w.Start {
			d = w.Start
		}
		if best < 0 || d < best {
			best = d
		}
	}
	return best
}

// NextStates enumerates every legal transition out of s, in a
// deterministic order: drives, discounted drives, refuel, wait.
func (sc *Scenario) NextStates(s State) []Action {
	var out []Action
	for i, e := range sc.Edges {
		if e.From != s.Node || e.Fuel > s.Fuel {
			continue
		}
		dep := earliestDepart(s.Time, e.Windows)
		if dep < 0 || dep+e.Time > sc.Horizon {
			continue
		}
		ns := State{Node: e.To, Fuel: s.Fuel - e.Fuel, Mask: s.Mask, Time: dep + e.Time}
		out = append(out, Action{Kind: "drive", Edge: i, Depart: dep, Arrive: ns.Time, Cost: e.Toll, Next: ns})
		if e.Discount >= 0 && s.Mask&(1<<uint(e.Discount)) == 0 {
			c := e.Toll - sc.Discounts[e.Discount]
			if c < 0 {
				c = 0
			}
			ns2 := ns
			ns2.Mask |= 1 << uint(e.Discount)
			out = append(out, Action{Kind: "discount", Edge: i, Depart: dep, Arrive: ns2.Time, Cost: c, Next: ns2})
		}
	}
	if st, ok := sc.stationAt(s.Node); ok && s.Fuel < sc.FuelCap && s.Time+st.Duration <= sc.Horizon && st.Free(s.Time) {
		ns := State{Node: s.Node, Fuel: sc.FuelCap, Mask: s.Mask, Time: s.Time + st.Duration}
		out = append(out, Action{Kind: "refuel", Edge: -1, Depart: s.Time, Arrive: ns.Time, Cost: st.Fee, Next: ns})
	}
	if s.Time < sc.Horizon {
		ns := s
		ns.Time++
		out = append(out, Action{Kind: "wait", Edge: -1, Depart: s.Time, Arrive: ns.Time, Cost: 0, Next: ns})
	}
	return out
}

// Replay validates a certificate: every step must be a legal transition
// and the final state must be the goal. It returns the total cost.
func (sc *Scenario) Replay(acts []Action) (int, error) {
	cur := State{Node: sc.Start, Fuel: sc.StartFuel}
	total := 0
	for i, want := range acts {
		matched := false
		for _, got := range sc.NextStates(cur) {
			if got.Kind == want.Kind && got.Edge == want.Edge && got.Cost == want.Cost && got.Next == want.Next {
				cur = got.Next
				total += got.Cost
				matched = true
				break
			}
		}
		if !matched {
			return 0, fmt.Errorf("step %d: illegal transition %+v", i, want)
		}
	}
	if cur.Node != sc.Goal {
		return 0, fmt.Errorf("replay ended at node %d, want goal %d", cur.Node, sc.Goal)
	}
	return total, nil
}
