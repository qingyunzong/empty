package pipes

import (
	"fmt"
	"math/big"
)

// Residual describes one violated equation as an exact fraction.
type Residual struct {
	Equation string
	Value    *big.Rat
}

func (r Residual) String() string {
	return fmt.Sprintf("%s: residual %s", r.Equation, r.Value.RatString())
}

// CheckSolution independently verifies a candidate solution against
// the network equations, evaluating every equation directly from the
// network definition (no reuse of the solver's matrix). It returns
// the list of violated equations with their exact fractional
// residuals; an empty list means the solution satisfies conservation
// at every injection node, the resistance law on every edge, and the
// head constraint at every anchored node.
func CheckSolution(net *Network, bcs []BC, sol *Solution) []Residual {
	var bad []Residual
	if len(sol.Pressures) != net.N || len(sol.Flows) != len(net.Edges) {
		return []Residual{{Equation: "dimension", Value: big.NewRat(1, 1)}}
	}
	bad = append(bad, checkResistance(net, sol.Pressures, sol.Flows)...)
	bad = append(bad, checkConservation(net, bcs, sol.Flows)...)
	bad = append(bad, checkHeads(net, bcs, sol.Pressures)...)
	return bad
}

// CheckNullVector independently verifies that v (over the unknown
// vector [pressures, flows]) lies in the null space of the
// homogeneous system: resistance rows and conservation rows must
// annihilate it, and its pressure entries must vanish on anchored
// nodes. Nonzero residuals are returned.
func CheckNullVector(net *Network, bcs []BC, v []*big.Rat) []Residual {
	var bad []Residual
	if len(v) != net.N+len(net.Edges) {
		return []Residual{{Equation: "dimension", Value: big.NewRat(1, 1)}}
	}
	p := v[:net.N]
	q := v[net.N:]
	bad = append(bad, checkResistance(net, p, q)...)
	// Homogeneous conservation at every injection node.
	for i := 0; i < net.N; i++ {
		if bcs[i].Injection == nil {
			continue
		}
		acc := new(big.Rat)
		for k, e := range net.Edges {
			if e.From == i {
				acc.Add(acc, q[k])
			}
			if e.To == i {
				acc.Sub(acc, q[k])
			}
		}
		if acc.Sign() != 0 {
			bad = append(bad, Residual{
				Equation: fmt.Sprintf("null conservation node %d", i),
				Value:    acc,
			})
		}
	}
	// Homogeneous head constraints: pressure must be zero on anchors.
	for i := 0; i < net.N; i++ {
		if bcs[i].Head != nil && p[i].Sign() != 0 {
			bad = append(bad, Residual{
				Equation: fmt.Sprintf("null head node %d", i),
				Value:    new(big.Rat).Set(p[i]),
			})
		}
	}
	return bad
}

// checkResistance verifies p_from - p_to = R*q on every edge.
func checkResistance(net *Network, p, q []*big.Rat) []Residual {
	var bad []Residual
	for k, e := range net.Edges {
		lhs := new(big.Rat).Sub(p[e.From], p[e.To])
		rhs := new(big.Rat).Mul(e.R, q[k])
		if lhs.Cmp(rhs) != 0 {
			bad = append(bad, Residual{
				Equation: fmt.Sprintf("resistance edge %d (%d->%d)", k, e.From, e.To),
				Value:    lhs.Sub(lhs, rhs),
			})
		}
	}
	return bad
}

// checkConservation verifies outflow - inflow = injection at every
// injection node.
func checkConservation(net *Network, bcs []BC, q []*big.Rat) []Residual {
	var bad []Residual
	for i := 0; i < net.N; i++ {
		if bcs[i].Injection == nil {
			continue
		}
		acc := new(big.Rat)
		for k, e := range net.Edges {
			if e.From == i {
				acc.Add(acc, q[k])
			}
			if e.To == i {
				acc.Sub(acc, q[k])
			}
		}
		if acc.Cmp(bcs[i].Injection) != 0 {
			bad = append(bad, Residual{
				Equation: fmt.Sprintf("conservation node %d", i),
				Value:    acc.Sub(acc, bcs[i].Injection),
			})
		}
	}
	return bad
}

// checkHeads verifies p_i = head at every anchored node.
func checkHeads(net *Network, bcs []BC, p []*big.Rat) []Residual {
	var bad []Residual
	for i := 0; i < net.N; i++ {
		if bcs[i].Head != nil && p[i].Cmp(bcs[i].Head) != 0 {
			bad = append(bad, Residual{
				Equation: fmt.Sprintf("head node %d", i),
				Value:    new(big.Rat).Sub(p[i], bcs[i].Head),
			})
		}
	}
	return bad
}
