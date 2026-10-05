// Package route implements a constrained route planner.
//
// Cost model:
//   - every directed edge carries a toll, a travel time and a fuel distance;
//   - a one-time rebate is redeemed only when the cumulative toll paid so far
//     reaches a threshold AND the path visits a designated toll station
//     afterwards (the rebate is a path-level event, never a negative edge);
//   - coupons depend on the set of already-traveled edges and are mutually
//     exclusive (at most one coupon per path);
//   - fuel capacity constrains travel, refueling is possible at priced
//     stations and the refuel cost is part of the paid cost.
//
// Objective: minimize actual paid cost first, then travel time.
// Paths are simple (no repeated nodes) and networks have at most 12 nodes
// and 6 coupons.
package route

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

const (
	MaxNodes   = 12
	MaxCoupons = 6
	MaxEdges   = 64 // edge set is tracked in a uint64 bitmask
)

// Edge is one directed road segment.
type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Toll int    `json:"toll"`
	Time int    `json:"time"`
	Dist int    `json:"dist"` // fuel consumed
}

// Coupon becomes eligible once every required edge has been traveled.
// Coupons are mutually exclusive: at most one may be applied per path.
type Coupon struct {
	ID       string      `json:"id"`
	Requires [][2]string `json:"requires"` // required traveled edges (from,to)
	Discount int         `json:"discount"`
}

// Rebate is a one-time cumulative full-threshold rebate, redeemed only at
// designated toll stations.
type Rebate struct {
	Threshold int      `json:"threshold"` // cumulative toll needed to qualify
	Amount    int      `json:"amount"`    // amount returned, once
	Stations  []string `json:"stations"`  // designated redemption stations
}

// Network is the parsed problem instance.
type Network struct {
	Start string   `json:"start"`
	End   string   `json:"end"`
	Fuel  FuelSpec `json:"fuel"`

	Nodes   []Node   `json:"nodes"`
	Edges   []Edge   `json:"edges"`
	Coupons []Coupon `json:"coupons"`
	Rebate  *Rebate  `json:"rebate,omitempty"`

	// derived
	nodeIdx   map[string]int
	edgeIdx   map[[2]int]int
	adj       [][]int // node -> edge indices leaving it
	station   []bool  // designated rebate redemption station
	fuelAt    []bool  // node sells fuel
	couponReq []uint64
}

// FuelSpec configures the tank.
type FuelSpec struct {
	Capacity int `json:"capacity"`
	Start    int `json:"start"`
}

// Node carries optional fuel pricing.
type Node struct {
	ID        string `json:"id"`
	FuelPrice int    `json:"fuelPrice,omitempty"` // 0 means: no fuel sold here
}

// Load parses and validates a network from JSON.
func Load(r io.Reader) (*Network, error) {
	var n Network
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&n); err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}
	if err := n.index(); err != nil {
		return nil, err
	}
	return &n, nil
}

func (n *Network) index() error {
	if len(n.Nodes) == 0 || len(n.Nodes) > MaxNodes {
		return fmt.Errorf("node count must be 1..%d, got %d", MaxNodes, len(n.Nodes))
	}
	if len(n.Coupons) > MaxCoupons {
		return fmt.Errorf("at most %d coupons allowed, got %d", MaxCoupons, len(n.Coupons))
	}
	if len(n.Edges) > MaxEdges {
		return fmt.Errorf("at most %d edges allowed, got %d", MaxEdges, len(n.Edges))
	}
	n.nodeIdx = make(map[string]int, len(n.Nodes))
	n.fuelAt = make([]bool, len(n.Nodes))
	for i, nd := range n.Nodes {
		if nd.ID == "" {
			return fmt.Errorf("node %d: empty id", i)
		}
		if _, dup := n.nodeIdx[nd.ID]; dup {
			return fmt.Errorf("duplicate node id %q", nd.ID)
		}
		if nd.FuelPrice < 0 {
			return fmt.Errorf("node %q: negative fuel price", nd.ID)
		}
		n.nodeIdx[nd.ID] = i
		n.fuelAt[i] = nd.FuelPrice > 0
	}
	if _, ok := n.nodeIdx[n.Start]; !ok {
		return fmt.Errorf("unknown start node %q", n.Start)
	}
	if _, ok := n.nodeIdx[n.End]; !ok {
		return fmt.Errorf("unknown end node %q", n.End)
	}
	if n.Fuel.Capacity < 0 || n.Fuel.Start < 0 || n.Fuel.Start > n.Fuel.Capacity {
		return fmt.Errorf("invalid fuel spec: capacity=%d start=%d", n.Fuel.Capacity, n.Fuel.Start)
	}
	n.edgeIdx = make(map[[2]int]int, len(n.Edges))
	n.adj = make([][]int, len(n.Nodes))
	for i, e := range n.Edges {
		f, ok := n.nodeIdx[e.From]
		if !ok {
			return fmt.Errorf("edge %d: unknown from %q", i, e.From)
		}
		t, ok := n.nodeIdx[e.To]
		if !ok {
			return fmt.Errorf("edge %d: unknown to %q", i, e.To)
		}
		if e.Toll < 0 || e.Time < 0 || e.Dist < 0 {
			return fmt.Errorf("edge %d: negative toll/time/dist", i)
		}
		if e.Dist > n.Fuel.Capacity {
			return fmt.Errorf("edge %d (%s->%s): dist %d exceeds fuel capacity %d", i, e.From, e.To, e.Dist, n.Fuel.Capacity)
		}
		n.edgeIdx[[2]int{f, t}] = i
		n.adj[f] = append(n.adj[f], i)
	}
	n.station = make([]bool, len(n.Nodes))
	if n.Rebate != nil {
		if n.Rebate.Threshold <= 0 || n.Rebate.Amount < 0 {
			return fmt.Errorf("rebate: threshold must be > 0 and amount >= 0")
		}
		for _, s := range n.Rebate.Stations {
			i, ok := n.nodeIdx[s]
			if !ok {
				return fmt.Errorf("rebate: unknown station %q", s)
			}
			n.station[i] = true
		}
	}
	n.couponReq = make([]uint64, len(n.Coupons))
	for ci, c := range n.Coupons {
		if c.ID == "" {
			return fmt.Errorf("coupon %d: empty id", ci)
		}
		if c.Discount < 0 {
			return fmt.Errorf("coupon %q: negative discount", c.ID)
		}
		var mask uint64
		for _, req := range c.Requires {
			f, ok := n.nodeIdx[req[0]]
			if !ok {
				return fmt.Errorf("coupon %q: unknown node %q", c.ID, req[0])
			}
			t, ok := n.nodeIdx[req[1]]
			if !ok {
				return fmt.Errorf("coupon %q: unknown node %q", c.ID, req[1])
			}
			ei, ok := n.edgeIdx[[2]int{f, t}]
			if !ok {
				return fmt.Errorf("coupon %q: required edge %s->%s not in network", c.ID, req[0], req[1])
			}
			mask |= 1 << uint(ei)
		}
		n.couponReq[ci] = mask
	}
	n.SortEdges()
	return nil
}

// NodeIndex resolves a node id to its index.
func (n *Network) NodeIndex(id string) (int, bool) { i, ok := n.nodeIdx[id]; return i, ok }

// NumNodes returns the node count.
func (n *Network) NumNodes() int { return len(n.Nodes) }

// NodeID returns the id of node i.
func (n *Network) NodeID(i int) string { return n.Nodes[i].ID }

// EdgeByIndex returns edge i.
func (n *Network) EdgeByIndex(i int) Edge { return n.Edges[i] }

// EdgeBetween resolves an edge by endpoint ids.
func (n *Network) EdgeBetween(from, to string) (Edge, bool) {
	fi, ok1 := n.nodeIdx[from]
	ti, ok2 := n.nodeIdx[to]
	if !ok1 || !ok2 {
		return Edge{}, false
	}
	ei, ok := n.edgeIdx[[2]int{fi, ti}]
	if !ok {
		return Edge{}, false
	}
	return n.Edges[ei], true
}

// OutEdges lists edge indices leaving node v.
func (n *Network) OutEdges(v int) []int { return n.adj[v] }

// EdgeEndpoints returns (from,to) node indices of edge i.
func (n *Network) EdgeEndpoints(i int) (int, int) {
	e := n.Edges[i]
	return n.nodeIdx[e.From], n.nodeIdx[e.To]
}

// FuelPriceAt returns the per-unit fuel price at node v and whether fuel is sold.
func (n *Network) FuelPriceAt(v int) (int, bool) { return n.Nodes[v].FuelPrice, n.fuelAt[v] }

// IsStation reports whether node v redeems the rebate.
func (n *Network) IsStation(v int) bool { return n.station[v] }

// CouponMask returns the required-edge bitmask of coupon i.
func (n *Network) CouponMask(i int) uint64 { return n.couponReq[i] }

// RebateInfo returns threshold, amount, configured.
func (n *Network) RebateInfo() (int, int, bool) {
	if n.Rebate == nil {
		return 0, 0, false
	}
	return n.Rebate.Threshold, n.Rebate.Amount, true
}

// PathNodeIDs renders a node-index path as ids.
func (n *Network) PathNodeIDs(path []int) []string {
	out := make([]string, len(path))
	for i, v := range path {
		out[i] = n.Nodes[v].ID
	}
	return out
}

// SortEdges canonicalizes adjacency order for deterministic output.
func (n *Network) SortEdges() {
	for v := range n.adj {
		sort.Slice(n.adj[v], func(a, b int) bool {
			ea, eb := n.Edges[n.adj[v][a]], n.Edges[n.adj[v][b]]
			if ea.To != eb.To {
				return ea.To < eb.To
			}
			return ea.Toll < eb.Toll
		})
	}
}
