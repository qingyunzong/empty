package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Hard limits from the problem statement.
const (
	MaxNodes     = 10
	MaxFuelCap   = 20
	MaxDiscounts = 6
	MaxHorizon   = 60
)

// Window is an inclusive departure-time interval [Start, End] during
// which a road segment is open.
type Window struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Edge is a directed road segment. Discount is the id of a one-time
// coupon applicable to this segment, or -1 for none.
type Edge struct {
	From     int      `json:"from"`
	To       int      `json:"to"`
	Fuel     int      `json:"fuel"`
	Time     int      `json:"time"`
	Toll     int      `json:"toll"`
	Windows  []Window `json:"windows,omitempty"`
	Discount int      `json:"discount"`
}

// Station is a supply/charging stop that refuels to full capacity.
// Occupancy[t] counts charging slots already taken by others at time t;
// refuelling may start at t only while Occupancy[t] < Capacity.
type Station struct {
	Node      int   `json:"node"`
	Fee       int   `json:"fee"`
	Duration  int   `json:"duration"`
	Capacity  int   `json:"capacity"`
	Occupancy []int `json:"occupancy,omitempty"`
}

// Free reports whether a charging slot is available at time t.
func (st Station) Free(t int) bool {
	occ := 0
	if t >= 0 && t < len(st.Occupancy) {
		occ = st.Occupancy[t]
	}
	return occ < st.Capacity
}

// Scenario is a fully specified routing instance.
type Scenario struct {
	Nodes     int       `json:"nodes"`
	Start     int       `json:"start"`
	Goal      int       `json:"goal"`
	FuelCap   int       `json:"fuelCap"`
	StartFuel int       `json:"startFuel"`
	Horizon   int       `json:"horizon"`
	Discounts []int     `json:"discounts,omitempty"`
	Edges     []Edge    `json:"edges"`
	Stations  []Station `json:"stations,omitempty"`
}

// LoadScenario reads and validates a scenario JSON file.
func LoadScenario(path string) (*Scenario, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sc Scenario
	if err := json.Unmarshal(data, &sc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := sc.Validate(); err != nil {
		return nil, fmt.Errorf("invalid scenario: %w", err)
	}
	return &sc, nil
}

// Validate enforces the problem limits and non-negative costs.
func (sc *Scenario) Validate() error {
	if sc.Nodes < 1 || sc.Nodes > MaxNodes {
		return fmt.Errorf("nodes=%d out of range [1,%d]", sc.Nodes, MaxNodes)
	}
	if sc.Start < 0 || sc.Start >= sc.Nodes {
		return fmt.Errorf("start=%d out of range", sc.Start)
	}
	if sc.Goal < 0 || sc.Goal >= sc.Nodes {
		return fmt.Errorf("goal=%d out of range", sc.Goal)
	}
	if sc.FuelCap < 1 || sc.FuelCap > MaxFuelCap {
		return fmt.Errorf("fuelCap=%d out of range [1,%d]", sc.FuelCap, MaxFuelCap)
	}
	if sc.StartFuel < 0 || sc.StartFuel > sc.FuelCap {
		return fmt.Errorf("startFuel=%d out of range [0,%d]", sc.StartFuel, sc.FuelCap)
	}
	if sc.Horizon < 1 || sc.Horizon > MaxHorizon {
		return fmt.Errorf("horizon=%d out of range [1,%d]", sc.Horizon, MaxHorizon)
	}
	if len(sc.Discounts) > MaxDiscounts {
		return fmt.Errorf("discounts=%d exceeds %d", len(sc.Discounts), MaxDiscounts)
	}
	for i, d := range sc.Discounts {
		if d < 0 {
			return fmt.Errorf("discount %d has negative value %d", i, d)
		}
	}
	for i, e := range sc.Edges {
		if e.From < 0 || e.From >= sc.Nodes || e.To < 0 || e.To >= sc.Nodes {
			return fmt.Errorf("edge %d: endpoint out of range", i)
		}
		if e.Fuel < 0 {
			return fmt.Errorf("edge %d: negative fuel %d", i, e.Fuel)
		}
		if e.Time < 1 {
			return fmt.Errorf("edge %d: travel time must be >= 1, got %d", i, e.Time)
		}
		if e.Toll < 0 {
			return fmt.Errorf("edge %d: negative toll %d", i, e.Toll)
		}
		for _, w := range e.Windows {
			if w.Start < 0 || w.End < w.Start || w.End > sc.Horizon {
				return fmt.Errorf("edge %d: bad window [%d,%d]", i, w.Start, w.End)
			}
		}
		if e.Discount < -1 || e.Discount >= len(sc.Discounts) {
			return fmt.Errorf("edge %d: discount id %d out of range", i, e.Discount)
		}
	}
	seen := map[int]bool{}
	for i, st := range sc.Stations {
		if st.Node < 0 || st.Node >= sc.Nodes {
			return fmt.Errorf("station %d: node out of range", i)
		}
		if seen[st.Node] {
			return fmt.Errorf("station %d: duplicate station at node %d", i, st.Node)
		}
		seen[st.Node] = true
		if st.Fee < 0 {
			return fmt.Errorf("station %d: negative fee", i)
		}
		if st.Duration < 1 {
			return fmt.Errorf("station %d: duration must be >= 1", i)
		}
		if st.Capacity < 1 {
			return fmt.Errorf("station %d: capacity must be >= 1", i)
		}
		for t, occ := range st.Occupancy {
			if occ < 0 {
				return fmt.Errorf("station %d: negative occupancy at t=%d", i, t)
			}
		}
	}
	return nil
}

func (sc *Scenario) stationAt(node int) (Station, bool) {
	for _, st := range sc.Stations {
		if st.Node == node {
			return st, true
		}
	}
	return Station{}, false
}
