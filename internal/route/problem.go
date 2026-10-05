// Package route implements a routing CLI core: path cost with per-edge
// tolls, a one-time cumulative full-amount rebate, mutually exclusive
// coupons that depend on the set of already-traveled edges, rebate
// redemption only at designated toll stations, and fuel capacity with
// refueling costs. Paths are simple (no repeated nodes) and limited to
// at most MaxNodes nodes.
package route

import (
	"encoding/json"
	"fmt"
	"io"
	"math/bits"
	"os"
)

// MaxCoupons is the maximum number of coupons supported.
const MaxCoupons = 6

// HardMaxNodes bounds the simple-path length (visited bitmask is uint32).
const HardMaxNodes = 31

// Edge is a directed arc with a toll, a travel time and a fuel consumption.
type Edge struct {
	From int   `json:"from"`
	To   int   `json:"to"`
	Toll int64 `json:"toll"`
	Time int64 `json:"time"`
	Fuel int64 `json:"fuel"`
}

// Coupon becomes earned once every edge in RequiresEdges has been
// traveled, and can then be applied to the toll of one later edge.
// Coupons are mutually exclusive: at most one coupon is used per path.
type Coupon struct {
	RequiresEdges []int `json:"requiresEdges"`
	Discount      int64 `json:"discount"`
}

// Rebate is a one-time cumulative full-amount rebate: once the cumulative
// net toll paid reaches Threshold, Amount is returned. The rebate is
// redeemed only when arriving at a node listed in Stations; if Stations
// is empty the rebate is redeemed immediately at the triggering node.
type Rebate struct {
	Threshold int64 `json:"threshold"`
	Amount    int64 `json:"amount"`
	Stations  []int `json:"stations"`
}

// FuelStation sells fuel at Node for Price per unit.
type FuelStation struct {
	Node  int   `json:"node"`
	Price int64 `json:"price"`
}

// Fuel describes the tank. Capacity 0 means "no fuel constraint".
type Fuel struct {
	Capacity int64         `json:"capacity"`
	Start    int64         `json:"start"`
	Stations []FuelStation `json:"stations"`
}

// Problem is the full routing instance.
type Problem struct {
	NumNodes int      `json:"numNodes"`
	Start    int      `json:"start"`
	End      int      `json:"end"`
	MaxNodes int      `json:"maxNodes"`
	Edges    []Edge   `json:"edges"`
	Rebate   Rebate   `json:"rebate"`
	Fuel     Fuel     `json:"fuel"`
	Coupons  []Coupon `json:"coupons"`
}

// Load reads a Problem as JSON from r.
func Load(r io.Reader) (*Problem, error) {
	var p Problem
	dec := json.NewDecoder(r)
	if err := dec.Decode(&p); err != nil {
		return nil, fmt.Errorf("decode problem: %w", err)
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return &p, nil
}

// LoadFile reads a Problem as JSON from a file ("-" means stdin).
func LoadFile(name string) (*Problem, error) {
	if name == "-" {
		return Load(os.Stdin)
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Load(f)
}

// Validate checks structural constraints.
func (p *Problem) Validate() error {
	if p.NumNodes <= 0 {
		return fmt.Errorf("numNodes must be positive")
	}
	if p.MaxNodes == 0 {
		p.MaxNodes = 12
	}
	if p.MaxNodes < 2 || p.MaxNodes > HardMaxNodes {
		return fmt.Errorf("maxNodes must be in [2,%d]", HardMaxNodes)
	}
	if p.NumNodes > HardMaxNodes {
		return fmt.Errorf("numNodes must be <= %d", HardMaxNodes)
	}
	inNode := func(v int) bool { return v >= 0 && v < p.NumNodes }
	if !inNode(p.Start) || !inNode(p.End) {
		return fmt.Errorf("start/end out of range")
	}
	if p.Start == p.End {
		return fmt.Errorf("start and end must differ")
	}
	for i, e := range p.Edges {
		if !inNode(e.From) || !inNode(e.To) {
			return fmt.Errorf("edge %d: endpoint out of range", i)
		}
		if e.From == e.To {
			return fmt.Errorf("edge %d: self loop not allowed", i)
		}
		if e.Toll < 0 || e.Time < 0 || e.Fuel < 0 {
			return fmt.Errorf("edge %d: toll/time/fuel must be >= 0", i)
		}
	}
	if p.Rebate.Threshold < 0 || p.Rebate.Amount < 0 {
		return fmt.Errorf("rebate threshold/amount must be >= 0")
	}
	for _, s := range p.Rebate.Stations {
		if !inNode(s) {
			return fmt.Errorf("rebate station %d out of range", s)
		}
	}
	if len(p.Coupons) > MaxCoupons {
		return fmt.Errorf("at most %d coupons, got %d", MaxCoupons, len(p.Coupons))
	}
	for i, c := range p.Coupons {
		if c.Discount < 0 {
			return fmt.Errorf("coupon %d: discount must be >= 0", i)
		}
		if len(c.RequiresEdges) == 0 {
			return fmt.Errorf("coupon %d: requiresEdges must not be empty", i)
		}
		seen := map[int]bool{}
		for _, e := range c.RequiresEdges {
			if e < 0 || e >= len(p.Edges) {
				return fmt.Errorf("coupon %d: edge id %d out of range", i, e)
			}
			if seen[e] {
				return fmt.Errorf("coupon %d: duplicate edge id %d", i, e)
			}
			seen[e] = true
		}
	}
	if p.Fuel.Capacity < 0 || p.Fuel.Start < 0 {
		return fmt.Errorf("fuel capacity/start must be >= 0")
	}
	if p.Fuel.Start > p.Fuel.Capacity {
		return fmt.Errorf("fuel start exceeds capacity")
	}
	needFuel := false
	for _, e := range p.Edges {
		if e.Fuel > 0 {
			needFuel = true
		}
	}
	if needFuel && p.Fuel.Capacity == 0 {
		return fmt.Errorf("edges consume fuel but fuel.capacity is 0")
	}
	for _, s := range p.Fuel.Stations {
		if !inNode(s.Node) {
			return fmt.Errorf("fuel station node %d out of range", s.Node)
		}
		if s.Price < 0 {
			return fmt.Errorf("fuel station %d: price must be >= 0", s.Node)
		}
		if p.Fuel.Capacity == 0 {
			return fmt.Errorf("fuel stations require fuel.capacity > 0")
		}
	}
	return nil
}

// fuelConstrained reports whether fuel limits apply.
func (p *Problem) fuelConstrained() bool { return p.Fuel.Capacity > 0 }

// fuelPriceAt returns the fuel price at node v and whether v sells fuel.
func (p *Problem) fuelPriceAt(v int) (int64, bool) {
	for _, s := range p.Fuel.Stations {
		if s.Node == v {
			return s.Price, true
		}
	}
	return 0, false
}

// isRebateStation reports whether v redeems the rebate.
func (p *Problem) isRebateStation(v int) bool {
	for _, s := range p.Rebate.Stations {
		if s == v {
			return true
		}
	}
	return false
}

// couponEdgeBit maps edge id -> coupon -> bit position within the
// coupon's required-edge list. Built lazily by bitIndex.
func (p *Problem) bitIndex() [][MaxCoupons]int {
	idx := make([][MaxCoupons]int, len(p.Edges))
	for e := range idx {
		for c := range idx[e] {
			idx[e][c] = -1
		}
	}
	for c, cp := range p.Coupons {
		for pos, e := range cp.RequiresEdges {
			idx[e][c] = pos
		}
	}
	return idx
}

// fullMask returns the completed progress mask for coupon c.
func (p *Problem) fullMask(c int) uint32 {
	return (uint32(1) << uint(len(p.Coupons[c].RequiresEdges))) - 1
}

// outAdj builds outgoing adjacency: node -> edge ids.
func (p *Problem) outAdj() [][]int {
	adj := make([][]int, p.NumNodes)
	for i, e := range p.Edges {
		adj[e.From] = append(adj[e.From], i)
	}
	return adj
}

// tollDistToEnd computes min-toll distances to End on the reverse graph
// (used as an admissible lower-bound component). Unreachable = -1.
func (p *Problem) tollDistToEnd() []int64 {
	const inf = int64(1) << 62
	dist := make([]int64, p.NumNodes)
	for i := range dist {
		dist[i] = inf
	}
	dist[p.End] = 0
	// Bellman-Ford over at most NumNodes-1 rounds (tolls >= 0, tiny graph).
	for it := 0; it < p.NumNodes; it++ {
		changed := false
		for _, e := range p.Edges {
			if dist[e.To] != inf && dist[e.To]+e.Toll < dist[e.From] {
				dist[e.From] = dist[e.To] + e.Toll
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	for i := range dist {
		if dist[i] == inf {
			dist[i] = -1
		}
	}
	return dist
}

func popcount32(v uint32) int { return bits.OnesCount32(v) }
