// Package pipenet solves steady-state flow in small linear resistive
// pipe networks (at most 8 nodes) with exact rational arithmetic.
//
// Each edge e = (U, V) obeys the linear resistance law
//
//	p_U - p_V = R_e * q_e
//
// where q_e is the signed flow from U to V. Every node carries exactly
// one boundary condition: a specified pressure head (Dirichlet) or a
// specified net injection (Neumann). A connected component containing
// no head-specified node is unanchored: its pressures are determined
// only up to an additive constant, so Solve reports a null-space basis
// vector as evidence of the non-uniqueness.
package pipenet

import (
	"fmt"
	"math/big"
)

// MaxNodes is the largest supported network size.
const MaxNodes = 8

// BCKind selects the boundary condition attached to a node.
type BCKind int

const (
	// Head fixes the node pressure to Node.Value.
	Head BCKind = iota
	// Injection fixes the net inflow into the node to Node.Value
	// (negative values model withdrawal).
	Injection
)

// Node is a network junction with exactly one boundary condition.
type Node struct {
	Kind  BCKind
	Value *big.Rat
}

// Edge is a pipe with linear resistance R > 0; positive flow runs U -> V.
type Edge struct {
	U, V int
	R    *big.Rat
}

// Network is a pipe network of at most MaxNodes nodes.
type Network struct {
	Nodes []Node
	Edges []Edge
}

// Validate checks structural invariants of the network.
func (n *Network) Validate() error {
	if len(n.Nodes) == 0 {
		return fmt.Errorf("pipenet: network has no nodes")
	}
	if len(n.Nodes) > MaxNodes {
		return fmt.Errorf("pipenet: %d nodes exceeds maximum %d", len(n.Nodes), MaxNodes)
	}
	for i, nd := range n.Nodes {
		if nd.Value == nil {
			return fmt.Errorf("pipenet: node %d has nil boundary value", i)
		}
		if nd.Kind != Head && nd.Kind != Injection {
			return fmt.Errorf("pipenet: node %d has unknown boundary kind %d", i, nd.Kind)
		}
	}
	for e, ed := range n.Edges {
		if ed.U < 0 || ed.U >= len(n.Nodes) || ed.V < 0 || ed.V >= len(n.Nodes) {
			return fmt.Errorf("pipenet: edge %d endpoint out of range", e)
		}
		if ed.U == ed.V {
			return fmt.Errorf("pipenet: edge %d is a self-loop at node %d", e, ed.U)
		}
		if ed.R == nil || ed.R.Sign() <= 0 {
			return fmt.Errorf("pipenet: edge %d resistance must be positive", e)
		}
	}
	return nil
}
