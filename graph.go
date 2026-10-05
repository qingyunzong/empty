// Package dagcache plans which shared intermediate products to cache in a
// dependency DAG so that the total recomputation cost of a fixed demand
// sequence is minimized under a cache space budget.
package dagcache

import (
	"errors"
	"fmt"
)

// MaxDemands bounds the length of a demand sequence (需求顺序固定，至多 20 次).
const MaxDemands = 20

// ErrTooManyDemands is returned when a demand sequence exceeds MaxDemands.
var ErrTooManyDemands = errors.New("dagcache: demand sequence exceeds 20 requests")

// Node is one computation in the dependency DAG.
type Node struct {
	Name string // human-readable identifier
	Cost int64  // compute fee paid every time the node is (re)computed
	Size int64  // cache space occupied while its product is cached
	Deps []int  // indices of nodes whose products are needed to compute this one
}

// Graph is a dependency DAG of computations.
type Graph struct {
	Nodes []Node
}

// Validate checks index bounds, non-negative fields and acyclicity.
func (g *Graph) Validate() error {
	if len(g.Nodes) == 0 {
		return errors.New("dagcache: graph has no nodes")
	}
	if len(g.Nodes) > 63 {
		return fmt.Errorf("dagcache: %d nodes exceeds bitmask limit of 63", len(g.Nodes))
	}
	for i, n := range g.Nodes {
		if n.Cost < 0 || n.Size < 0 {
			return fmt.Errorf("dagcache: node %d (%q) has negative cost or size", i, n.Name)
		}
		for _, d := range n.Deps {
			if d < 0 || d >= len(g.Nodes) {
				return fmt.Errorf("dagcache: node %d (%q) has out-of-range dep %d", i, n.Name, d)
			}
			if d == i {
				return fmt.Errorf("dagcache: node %d (%q) depends on itself", i, n.Name)
			}
		}
	}
	// Iterative DFS cycle detection (white/gray/black).
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make([]int, len(g.Nodes))
	var visit func(v int) error
	visit = func(v int) error {
		color[v] = gray
		for _, d := range g.Nodes[v].Deps {
			switch color[d] {
			case gray:
				return fmt.Errorf("dagcache: cycle detected through node %d (%q)", d, g.Nodes[d].Name)
			case white:
				if err := visit(d); err != nil {
					return err
				}
			}
		}
		color[v] = black
		return nil
	}
	for v := range g.Nodes {
		if color[v] == white {
			if err := visit(v); err != nil {
				return err
			}
		}
	}
	return nil
}

// sizeOf returns the total cache space occupied by the nodes in mask.
func (g *Graph) sizeOf(mask uint64) int64 {
	var total int64
	for i, n := range g.Nodes {
		if mask>>uint(i)&1 == 1 {
			total += n.Size
		}
	}
	return total
}

// recompute returns the set of nodes that must be (re)computed to serve a
// demand for target given the current cache, plus the compute fee incurred.
// A cached node is reused directly, so neither it nor its ancestors recompute.
func (g *Graph) recompute(cached uint64, target int) (mask uint64, cost int64) {
	var visit func(v int)
	visit = func(v int) {
		bit := uint64(1) << uint(v)
		if cached&bit != 0 || mask&bit != 0 {
			return
		}
		mask |= bit
		cost += g.Nodes[v].Cost
		for _, d := range g.Nodes[v].Deps {
			visit(d)
		}
	}
	visit(target)
	return mask, cost
}

// submasks calls fn for every submask of mask (including mask and 0).
func submasks(mask uint64, fn func(sub uint64)) {
	for sub := mask; ; sub = (sub - 1) & mask {
		fn(sub)
		if sub == 0 {
			break
		}
	}
}
