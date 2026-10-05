package main

import "fmt"

// StateDesc is the human-readable form of a state inside a certificate.
type StateDesc struct {
	Node    int   `json:"node"`
	Fuel    int   `json:"fuel"`
	Time    int   `json:"time"`
	Coupons []int `json:"coupons"` // remaining coupon ids
	Slots   []int `json:"slots"`   // remaining charging slots per station
}

func describe(s State) StateDesc {
	d := StateDesc{Node: s.Node, Fuel: s.Fuel, Time: s.Time, Coupons: []int{}, Slots: []int{}}
	for i := 0; i < MaxCoupons; i++ {
		if s.Coupons&(1<<uint(i)) != 0 {
			d.Coupons = append(d.Coupons, i)
		}
	}
	for i := 0; i < MaxStations; i++ {
		d.Slots = append(d.Slots, s.Slots[i])
	}
	return d
}

func sameDesc(a, b StateDesc) bool {
	if a.Node != b.Node || a.Fuel != b.Fuel || a.Time != b.Time {
		return false
	}
	if len(a.Coupons) != len(b.Coupons) || len(a.Slots) != len(b.Slots) {
		return false
	}
	for i := range a.Coupons {
		if a.Coupons[i] != b.Coupons[i] {
			return false
		}
	}
	for i := range a.Slots {
		if a.Slots[i] != b.Slots[i] {
			return false
		}
	}
	return true
}

// CertStep is one certified state transition.
type CertStep struct {
	Index      int       `json:"index"`
	Action     string    `json:"action"` // "traverse" or "refuel"
	Edge       int       `json:"edge"`
	Station    int       `json:"station"`
	Amount     int       `json:"amount,omitempty"`
	UseCoupon  bool      `json:"useCoupon,omitempty"`
	From       StateDesc `json:"from"`
	To         StateDesc `json:"to"`
	Cost       int       `json:"cost"`
	Cumulative int       `json:"cumulative"`
}

// Certificate is the step-by-step proof of the optimal route. LowerBound is
// the optimal cost itself: Dijkstra settles goal states in non-decreasing
// cost order (all transition costs are non-negative), so no cheaper feasible
// route exists.
type Certificate struct {
	Cost       int        `json:"cost"`
	LowerBound int        `json:"lowerBound"`
	Steps      []CertStep `json:"steps"`
}

// BuildCertificate renders the solver's optimal path as a certificate.
func BuildCertificate(s *Solver) *Certificate {
	states, trs := s.Path()
	cert := &Certificate{Cost: s.Best, LowerBound: s.Best}
	cum := 0
	for i, tr := range trs {
		cum += tr.Cost
		cert.Steps = append(cert.Steps, CertStep{
			Index:      i,
			Action:     tr.Kind,
			Edge:       tr.Edge,
			Station:    tr.Station,
			Amount:     tr.Amount,
			UseCoupon:  tr.UseCoupon,
			From:       describe(states[i]),
			To:         describe(states[i+1]),
			Cost:       tr.Cost,
			Cumulative: cum,
		})
	}
	return cert
}

// VerifyCertificate independently replays a certificate against the graph:
// every step must match a legal, freshly recomputed transition, the cumulative
// cost must add up, and the final state must be the goal.
func VerifyCertificate(g *Graph, cert *Certificate) error {
	if cert.Cost < 0 || cert.LowerBound != cert.Cost {
		return fmt.Errorf("certificate cost %d / lower bound %d inconsistent", cert.Cost, cert.LowerBound)
	}
	cur := g.InitialState()
	if len(cert.Steps) > 0 && !sameDesc(cert.Steps[0].From, describe(cur)) {
		return fmt.Errorf("step 0: from-state does not match the initial state")
	}
	cum := 0
	for i, step := range cert.Steps {
		if step.Index != i {
			return fmt.Errorf("step %d: bad index %d", i, step.Index)
		}
		if !sameDesc(step.From, describe(cur)) {
			return fmt.Errorf("step %d: from-state mismatch", i)
		}
		var matched *Succ
		for _, succ := range g.Successors(cur) {
			if succ.Tr.Kind != step.Action || succ.Tr.Edge != step.Edge ||
				succ.Tr.Station != step.Station || succ.Tr.Amount != step.Amount ||
				succ.Tr.UseCoupon != step.UseCoupon {
				continue
			}
			if sameDesc(describe(succ.Next), step.To) {
				m := succ
				matched = &m
				break
			}
		}
		if matched == nil {
			return fmt.Errorf("step %d: no legal transition produces the claimed next state", i)
		}
		if matched.Tr.Cost != step.Cost {
			return fmt.Errorf("step %d: claimed cost %d, recomputed %d", i, step.Cost, matched.Tr.Cost)
		}
		cum += step.Cost
		if step.Cumulative != cum {
			return fmt.Errorf("step %d: cumulative %d, expected %d", i, step.Cumulative, cum)
		}
		cur = matched.Next
	}
	if cur.Node != g.Goal {
		return fmt.Errorf("final state is node %d, goal is %d", cur.Node, g.Goal)
	}
	if cum != cert.Cost {
		return fmt.Errorf("total cost %d, certificate claims %d", cum, cert.Cost)
	}
	return nil
}
