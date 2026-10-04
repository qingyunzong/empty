// Package transferplan finds minimum-cost transfer plans on small
// networks. Each transport edge has an integer capacity, an integer
// per-unit cost, and a fixed integer loss: when an edge carries f > 0
// units, f units leave the source node, the loss is deducted first,
// and f - Loss units arrive at the destination (so f must be >= Loss).
// Goods are otherwise conserved: every unit sent is either delivered
// or accounted for by edge losses.
//
// Problem sizes are bounded: at most MaxNodes nodes, MaxEdges edges,
// and per-node inventory (supply or demand) of at most MaxStock.
package transferplan

import (
	"errors"
	"fmt"
)

// Problem size limits.
const (
	MaxNodes = 8
	MaxEdges = 10
	MaxStock = 20
)

// ErrInfeasible is returned when no transfer plan satisfies all demands.
var ErrInfeasible = errors.New("transferplan: no feasible plan")

// Edge is a directed transport edge. Flow f in [0, Cap] may be sent;
// sending f > 0 costs f * Cost and delivers f - Loss units.
type Edge struct {
	From, To        int
	Cap, Cost, Loss int
}

// Problem describes a transfer planning instance. Supply[i] is the
// initial inventory at node i; Demand[i] is the required final
// inventory at node i.
type Problem struct {
	Nodes  int
	Edges  []Edge
	Supply []int
	Demand []int
}

// Plan is a solution: Flows[k] is the amount sent on edge k and Cost
// is the total transportation cost.
type Plan struct {
	Cost  int
	Flows []int
}

// Validate checks the problem against the size limits and parameter
// ranges.
func (p Problem) Validate() error {
	if p.Nodes < 1 || p.Nodes > MaxNodes {
		return fmt.Errorf("transferplan: %d nodes out of range [1, %d]", p.Nodes, MaxNodes)
	}
	if len(p.Edges) > MaxEdges {
		return fmt.Errorf("transferplan: %d edges exceeds limit %d", len(p.Edges), MaxEdges)
	}
	if len(p.Supply) != p.Nodes || len(p.Demand) != p.Nodes {
		return fmt.Errorf("transferplan: supply and demand must have length %d", p.Nodes)
	}
	for i := 0; i < p.Nodes; i++ {
		if p.Supply[i] < 0 || p.Supply[i] > MaxStock {
			return fmt.Errorf("transferplan: supply[%d]=%d out of range [0, %d]", i, p.Supply[i], MaxStock)
		}
		if p.Demand[i] < 0 || p.Demand[i] > MaxStock {
			return fmt.Errorf("transferplan: demand[%d]=%d out of range [0, %d]", i, p.Demand[i], MaxStock)
		}
	}
	for k, e := range p.Edges {
		if e.From < 0 || e.From >= p.Nodes || e.To < 0 || e.To >= p.Nodes {
			return fmt.Errorf("transferplan: edge %d endpoint out of range", k)
		}
		if e.From == e.To {
			return fmt.Errorf("transferplan: edge %d is a self loop", k)
		}
		if e.Cap < 0 || e.Cost < 0 || e.Loss < 0 {
			return fmt.Errorf("transferplan: edge %d has a negative parameter", k)
		}
	}
	return nil
}

// Verify checks that plan is a valid, demand-satisfying plan for p
// whose reported cost matches its flows.
func Verify(p Problem, plan Plan) error {
	if err := p.Validate(); err != nil {
		return err
	}
	if len(plan.Flows) != len(p.Edges) {
		return fmt.Errorf("transferplan: plan has %d flows, want %d", len(plan.Flows), len(p.Edges))
	}
	balance := make([]int, p.Nodes) // net units shipped out of each node
	cost := 0
	for k, e := range p.Edges {
		f := plan.Flows[k]
		if f < 0 || f > e.Cap {
			return fmt.Errorf("transferplan: edge %d flow %d outside [0, %d]", k, f, e.Cap)
		}
		if f > 0 && f < e.Loss {
			return fmt.Errorf("transferplan: edge %d flow %d below fixed loss %d", k, f, e.Loss)
		}
		arrived := 0
		if f > 0 {
			arrived = f - e.Loss
		}
		balance[e.From] += f
		balance[e.To] -= arrived
		cost += f * e.Cost
	}
	if cost != plan.Cost {
		return fmt.Errorf("transferplan: plan cost %d, flows give %d", plan.Cost, cost)
	}
	for i := 0; i < p.Nodes; i++ {
		if balance[i] > p.Supply[i]-p.Demand[i] {
			return fmt.Errorf("transferplan: node %d final inventory %d below demand %d",
				i, p.Supply[i]-balance[i], p.Demand[i])
		}
	}
	return nil
}
