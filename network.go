// Package pipes solves linear pipe-resistance networks with rational
// coefficients. Networks have at most MaxNodes nodes. Each node is
// constrained either by a fixed pressure head or by a fixed net
// injection. Edge flow q (positive From -> To) obeys the linear
// resistance law p_from - p_to = R * q.
package pipes

import (
	"fmt"
	"math/big"
)

// MaxNodes is the maximum number of nodes in a network.
const MaxNodes = 8

// Edge is a directed pipe with constant linear resistance R > 0.
type Edge struct {
	From, To int
	R        *big.Rat
}

// BC is the boundary condition of a node: exactly one of Head
// (fixed pressure) or Injection (fixed net inflow) must be non-nil.
type BC struct {
	Head      *big.Rat
	Injection *big.Rat
}

// Network is a pipe network with N nodes and a list of edges.
type Network struct {
	N     int
	Edges []Edge
}

// Solution is the result of Solve. Pressures has length N, Flows has
// one entry per edge. When the system is underdetermined (a connected
// component without any head anchor), Unique is false and Nullspace
// holds a basis of the homogeneous system over the unknown vector
// [p_0..p_{N-1}, q_0..q_{E-1}] as exact rationals; every basis vector
// is certified by CheckNullVector.
type Solution struct {
	Pressures []*big.Rat
	Flows     []*big.Rat
	Unique    bool
	Nullspace [][]*big.Rat
}

// InconsistentError reports that the boundary conditions admit no
// solution, e.g. injections in an unanchored component that do not
// sum to zero.
type InconsistentError struct {
	Reason string
}

func (e *InconsistentError) Error() string { return e.Reason }

// Validate checks structural constraints of the network and BCs.
func Validate(net *Network, bcs []BC) error {
	if net.N < 1 || net.N > MaxNodes {
		return fmt.Errorf("node count %d out of range [1,%d]", net.N, MaxNodes)
	}
	if len(bcs) != net.N {
		return fmt.Errorf("need %d boundary conditions, got %d", net.N, len(bcs))
	}
	for i, bc := range bcs {
		if (bc.Head == nil) == (bc.Injection == nil) {
			return fmt.Errorf("node %d: exactly one of Head/Injection required", i)
		}
	}
	for k, e := range net.Edges {
		if e.From < 0 || e.From >= net.N || e.To < 0 || e.To >= net.N {
			return fmt.Errorf("edge %d: endpoint out of range", k)
		}
		if e.From == e.To {
			return fmt.Errorf("edge %d: self-loop", k)
		}
		if e.R == nil || e.R.Sign() <= 0 {
			return fmt.Errorf("edge %d: resistance must be positive", k)
		}
	}
	return nil
}
