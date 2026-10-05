package pipes

import (
	"fmt"
	"math/big"
)

// buildSystem assembles the linear system A x = b over the unknown
// vector x = [p_0..p_{N-1}, q_0..q_{E-1}]:
//   - one resistance row per edge: p_from - p_to - R*q_e = 0
//   - one row per node: p_i = head, or conservation
//     (outflow - inflow = injection).
func buildSystem(net *Network, bcs []BC) (rows [][]*big.Rat, rhs []*big.Rat) {
	n := net.N
	ncols := n + len(net.Edges)
	zeroRow := func() []*big.Rat {
		row := make([]*big.Rat, ncols)
		for j := range row {
			row[j] = new(big.Rat)
		}
		return row
	}
	for k, e := range net.Edges {
		row := zeroRow()
		row[e.From].SetInt64(1)
		row[e.To].SetInt64(-1)
		row[n+k] = new(big.Rat).Neg(e.R)
		rows = append(rows, row)
		rhs = append(rhs, new(big.Rat))
	}
	for i := 0; i < n; i++ {
		row := zeroRow()
		if bcs[i].Head != nil {
			row[i].SetInt64(1)
			rhs = append(rhs, new(big.Rat).Set(bcs[i].Head))
		} else {
			for k, e := range net.Edges {
				if e.From == i {
					row[n+k].Add(row[n+k], big.NewRat(1, 1))
				}
				if e.To == i {
					row[n+k].Sub(row[n+k], big.NewRat(1, 1))
				}
			}
			rhs = append(rhs, new(big.Rat).Set(bcs[i].Injection))
		}
		rows = append(rows, row)
	}
	return rows, rhs
}

// Solve solves the network for node pressures and edge flows with
// exact rational arithmetic. Components without a head anchor make
// the system underdetermined; Solve then returns a particular
// solution together with a nullspace basis certifying non-uniqueness.
// If the boundary conditions are inconsistent it returns an
// *InconsistentError describing the unbalanced component.
func Solve(net *Network, bcs []BC) (*Solution, error) {
	if err := Validate(net, bcs); err != nil {
		return nil, err
	}
	rows, rhs := buildSystem(net, bcs)
	rr := rref(rows, rhs, net.N+len(net.Edges))
	if rr.inconsistent() {
		return nil, describeInconsistency(net, bcs)
	}
	x := rr.particular()
	sol := &Solution{
		Pressures: x[:net.N],
		Flows:     x[net.N:],
	}
	null := rr.nullspace()
	if len(null) > 0 {
		sol.Unique = false
		sol.Nullspace = null
	} else {
		sol.Unique = true
	}
	return sol, nil
}

// describeInconsistency finds an unanchored connected component whose
// injections do not sum to zero, to explain the inconsistency.
func describeInconsistency(net *Network, bcs []BC) error {
	parent := make([]int, net.N)
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(x int) int {
		if parent[x] != x {
			parent[x] = find(parent[x])
		}
		return parent[x]
	}
	for _, e := range net.Edges {
		parent[find(e.From)] = find(e.To)
	}
	sum := map[int]*big.Rat{}
	anchored := map[int]bool{}
	members := map[int][]int{}
	for i := 0; i < net.N; i++ {
		rt := find(i)
		members[rt] = append(members[rt], i)
		if bcs[i].Head != nil {
			anchored[rt] = true
		}
		if bcs[i].Injection != nil {
			if sum[rt] == nil {
				sum[rt] = new(big.Rat)
			}
			sum[rt].Add(sum[rt], bcs[i].Injection)
		}
	}
	for rt, s := range sum {
		if !anchored[rt] && s.Sign() != 0 {
			return &InconsistentError{Reason: fmt.Sprintf(
				"unanchored component %v has net injection %s != 0",
				members[rt], s.RatString())}
		}
	}
	return &InconsistentError{Reason: "system is inconsistent"}
}
