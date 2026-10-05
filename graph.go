package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Hard limits of the model (see README.md).
const (
	MaxNodes    = 10 // at most 10 nodes
	MaxFuelCap  = 20 // integer fuel 0..20
	MaxCoupons  = 6  // 6 one-time coupons
	MaxStations = 4  // supply stations tracked in the state
	MaxSlotCap  = 3  // charging slots per station
	MaxTimeCap  = 60 // time horizon
)

// Window is a half-open-ish inclusive interval [Start, End] during which an
// edge is open. A traversal must fit entirely inside one window.
type Window struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Edge is a directed road segment.
type Edge struct {
	From     int      `json:"from"`
	To       int      `json:"to"`
	Fuel     int      `json:"fuel"`     // integer fuel consumed
	Time     int      `json:"time"`     // travel time, >= 1
	Toll     int      `json:"toll"`     // base toll
	Windows  []Window `json:"windows"`  // open windows; empty means always open
	Coupon   int      `json:"coupon"`   // coupon index usable on this edge, -1 = none
	Discount int      `json:"discount"` // discount when the coupon is spent
}

// Station is a supply station located at a node. Each refuel action consumes
// one charging slot; Capacity is the number of remaining slots.
type Station struct {
	Node       int `json:"node"`
	Price      int `json:"price"`      // cost per fuel unit
	RefuelTime int `json:"refuelTime"` // time per fuel unit, >= 1
	Capacity   int `json:"capacity"`   // charging slots (refuel actions)
}

// Graph is the full problem instance.
type Graph struct {
	NumNodes int       `json:"numNodes"`
	Start    int       `json:"start"`
	Goal     int       `json:"goal"`
	MaxFuel  int       `json:"maxFuel"`
	MaxTime  int       `json:"maxTime"`
	Edges    []Edge    `json:"edges"`
	Stations []Station `json:"stations"`
}

// TollPaid computes the effective toll for traversing e with fuelBefore units
// of fuel remaining. The toll depends on the remaining integer fuel through a
// low-fuel surcharge and is always non-negative.
//
//	toll = base + (maxFuel - fuelBefore)/2, minus discount if a coupon is
//	spent, floored at 0.
func (g *Graph) TollPaid(e Edge, fuelBefore int, useCoupon bool) int {
	t := e.Toll + (g.MaxFuel-fuelBefore)/2
	if useCoupon {
		t -= e.Discount
		if t < 0 {
			t = 0
		}
	}
	return t
}

// LoadGraph reads and validates a graph JSON file.
func LoadGraph(path string) (*Graph, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var g Graph
	if err := json.Unmarshal(data, &g); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := g.Validate(); err != nil {
		return nil, fmt.Errorf("invalid graph %s: %w", path, err)
	}
	return &g, nil
}

// Validate enforces the model limits so the state space stays finite and
// packable, and so costs stay non-negative.
func (g *Graph) Validate() error {
	if g.NumNodes < 1 || g.NumNodes > MaxNodes {
		return fmt.Errorf("numNodes %d out of range [1,%d]", g.NumNodes, MaxNodes)
	}
	if g.Start < 0 || g.Start >= g.NumNodes || g.Goal < 0 || g.Goal >= g.NumNodes {
		return fmt.Errorf("start/goal out of range")
	}
	if g.MaxFuel < 1 || g.MaxFuel > MaxFuelCap {
		return fmt.Errorf("maxFuel %d out of range [1,%d]", g.MaxFuel, MaxFuelCap)
	}
	if g.MaxTime < 1 || g.MaxTime > MaxTimeCap {
		return fmt.Errorf("maxTime %d out of range [1,%d]", g.MaxTime, MaxTimeCap)
	}
	for i, e := range g.Edges {
		if e.From < 0 || e.From >= g.NumNodes || e.To < 0 || e.To >= g.NumNodes {
			return fmt.Errorf("edge %d: endpoint out of range", i)
		}
		if e.Fuel < 0 || e.Fuel > g.MaxFuel {
			return fmt.Errorf("edge %d: fuel %d out of range", i, e.Fuel)
		}
		if e.Time < 1 {
			return fmt.Errorf("edge %d: time must be >= 1 (keeps the state graph acyclic)", i)
		}
		if e.Toll < 0 || e.Discount < 0 {
			return fmt.Errorf("edge %d: negative toll/discount", i)
		}
		if e.Coupon < -1 || e.Coupon >= MaxCoupons {
			return fmt.Errorf("edge %d: coupon %d out of range", i, e.Coupon)
		}
		for _, w := range e.Windows {
			if w.Start < 0 || w.End > g.MaxTime || w.Start > w.End {
				return fmt.Errorf("edge %d: bad window [%d,%d]", i, w.Start, w.End)
			}
		}
	}
	if len(g.Stations) > MaxStations {
		return fmt.Errorf("at most %d stations supported", MaxStations)
	}
	for i, s := range g.Stations {
		if s.Node < 0 || s.Node >= g.NumNodes {
			return fmt.Errorf("station %d: node out of range", i)
		}
		if s.Price < 0 {
			return fmt.Errorf("station %d: negative price", i)
		}
		if s.RefuelTime < 1 {
			return fmt.Errorf("station %d: refuelTime must be >= 1", i)
		}
		if s.Capacity < 0 || s.Capacity > MaxSlotCap {
			return fmt.Errorf("station %d: capacity %d out of range [0,%d]", i, s.Capacity, MaxSlotCap)
		}
	}
	return nil
}

// stationAt returns the station index located at node, or -1.
func (g *Graph) stationAt(node int) int {
	for i, s := range g.Stations {
		if s.Node == node {
			return i
		}
	}
	return -1
}

// earliestDepart returns the earliest departure time >= t such that the
// traversal [d, d+dur] fits inside one open window. Empty windows mean the
// edge is always open within [0, MaxTime].
func (g *Graph) earliestDepart(wins []Window, t, dur int) (int, bool) {
	if len(wins) == 0 {
		if t+dur <= g.MaxTime {
			return t, true
		}
		return 0, false
	}
	best := -1
	for _, w := range wins {
		d := t
		if d < w.Start {
			d = w.Start
		}
		if d+dur <= w.End && (best < 0 || d < best) {
			best = d
		}
	}
	if best < 0 {
		return 0, false
	}
	return best, true
}
