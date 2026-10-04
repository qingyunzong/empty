package pipenet

import (
	"errors"
	"fmt"
	"math/big"
)

// Solution is the exact rational steady state of a Network.
type Solution struct {
	// Pressures[i] is the solved pressure head at node i.
	Pressures []*big.Rat
	// Flows[e] is the signed flow on edge e, positive from U to V.
	Flows []*big.Rat
	// Injections[i] is the net inflow at node i: the specified value
	// for Injection nodes, the computed residual for Head nodes.
	Injections []*big.Rat
	// NullSpace holds one basis vector per unanchored component: the
	// indicator vector of that component. Adding any multiple of it to
	// Pressures yields another valid solution (pressures are only
	// determined up to a constant there).
	NullSpace [][]*big.Rat
}

// Solve computes exact rational pressures and flows for net.
func Solve(net *Network) (*Solution, error) {
	if err := net.Validate(); err != nil {
		return nil, err
	}
	n := len(net.Nodes)
	lap := laplacian(net)
	comps := components(net)

	p := make([]*big.Rat, n)
	for i := range p {
		p[i] = new(big.Rat)
	}
	var nullSpace [][]*big.Rat

	for ci, comp := range comps {
		var anchors, unknowns []int
		for _, i := range comp {
			if net.Nodes[i].Kind == Head {
				anchors = append(anchors, i)
			} else {
				unknowns = append(unknowns, i)
			}
		}
		switch {
		case len(anchors) > 0:
			for _, i := range anchors {
				p[i].Set(net.Nodes[i].Value)
			}
			if err := solveFree(net, lap, p, unknowns); err != nil {
				return nil, fmt.Errorf("pipenet: component %d: %w", ci, err)
			}
		default:
			// Unanchored component: solvable only when injections
			// balance; pressures unique only up to a constant.
			sum := new(big.Rat)
			for _, i := range comp {
				sum.Add(sum, net.Nodes[i].Value)
			}
			if sum.Sign() != 0 {
				return nil, fmt.Errorf("pipenet: component %d unanchored with unbalanced net injection %s: no solution", ci, sum.RatString())
			}
			// Ground the first node to pin one particular solution.
			if err := solveFree(net, lap, p, unknowns[1:]); err != nil {
				return nil, fmt.Errorf("pipenet: component %d: %w", ci, err)
			}
			v := make([]*big.Rat, n)
			for i := range v {
				v[i] = new(big.Rat)
			}
			for _, i := range comp {
				v[i].SetInt64(1)
			}
			nullSpace = append(nullSpace, v)
		}
	}

	flows := make([]*big.Rat, len(net.Edges))
	for e, ed := range net.Edges {
		flows[e] = new(big.Rat).Sub(p[ed.U], p[ed.V])
		flows[e].Quo(flows[e], ed.R)
	}
	inj := make([]*big.Rat, n)
	for i := range inj {
		inj[i] = matVecRow(lap, p, i)
	}
	return &Solution{Pressures: p, Flows: flows, Injections: inj, NullSpace: nullSpace}, nil
}

// solveFree solves the grounded Laplacian subsystem for the listed
// unknown node pressures, given already-fixed pressures in p.
func solveFree(net *Network, lap [][]*big.Rat, p []*big.Rat, unknowns []int) error {
	if len(unknowns) == 0 {
		return nil
	}
	k := len(unknowns)
	a := make([][]*big.Rat, k)
	b := make([]*big.Rat, k)
	for r, i := range unknowns {
		a[r] = make([]*big.Rat, k)
		rhs := new(big.Rat).Set(net.Nodes[i].Value)
		for c, j := range unknowns {
			a[r][c] = new(big.Rat).Set(lap[i][j])
		}
		for j := range net.Nodes {
			isUnknown := false
			for _, u := range unknowns {
				if u == j {
					isUnknown = true
					break
				}
			}
			if !isUnknown {
				rhs.Sub(rhs, new(big.Rat).Mul(lap[i][j], p[j]))
			}
		}
		b[r] = rhs
	}
	x, err := solveSquare(a, b)
	if err != nil {
		return err
	}
	for r, i := range unknowns {
		p[i].Set(x[r])
	}
	return nil
}

// laplacian builds the weighted Laplacian L with L_ii = sum of incident
// conductances and L_ij = -1/R for each edge {i,j}.
func laplacian(net *Network) [][]*big.Rat {
	n := len(net.Nodes)
	lap := make([][]*big.Rat, n)
	for i := range lap {
		lap[i] = make([]*big.Rat, n)
		for j := range lap[i] {
			lap[i][j] = new(big.Rat)
		}
	}
	for _, ed := range net.Edges {
		g := new(big.Rat).Inv(ed.R)
		lap[ed.U][ed.U].Add(lap[ed.U][ed.U], g)
		lap[ed.V][ed.V].Add(lap[ed.V][ed.V], g)
		lap[ed.U][ed.V].Sub(lap[ed.U][ed.V], g)
		lap[ed.V][ed.U].Sub(lap[ed.V][ed.U], g)
	}
	return lap
}

// components returns the connected components (as node index lists)
// via union-find over edges.
func components(net *Network) [][]int {
	n := len(net.Nodes)
	parent := make([]int, n)
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
	for _, ed := range net.Edges {
		ru, rv := find(ed.U), find(ed.V)
		if ru != rv {
			parent[ru] = rv
		}
	}
	groups := map[int][]int{}
	var order []int
	for i := 0; i < n; i++ {
		r := find(i)
		if _, ok := groups[r]; !ok {
			order = append(order, r)
		}
		groups[r] = append(groups[r], i)
	}
	comps := make([][]int, len(order))
	for i, r := range order {
		comps[i] = groups[r]
	}
	return comps
}

func matVecRow(a [][]*big.Rat, x []*big.Rat, i int) *big.Rat {
	acc := new(big.Rat)
	for j, aij := range a[i] {
		acc.Add(acc, new(big.Rat).Mul(aij, x[j]))
	}
	return acc
}

var errSingular = errors.New("pipenet: singular system")

// solveSquare solves A x = b over the rationals by Gauss-Jordan
// elimination with exact big.Rat arithmetic.
func solveSquare(a [][]*big.Rat, b []*big.Rat) ([]*big.Rat, error) {
	n := len(a)
	m := make([][]*big.Rat, n)
	for i := range m {
		if len(a[i]) != n {
			return nil, fmt.Errorf("pipenet: row %d has length %d, want %d", i, len(a[i]), n)
		}
		m[i] = make([]*big.Rat, n+1)
		for j := 0; j < n; j++ {
			m[i][j] = new(big.Rat).Set(a[i][j])
		}
		m[i][n] = new(big.Rat).Set(b[i])
	}
	for col := 0; col < n; col++ {
		piv := -1
		for r := col; r < n; r++ {
			if m[r][col].Sign() != 0 {
				piv = r
				break
			}
		}
		if piv < 0 {
			return nil, errSingular
		}
		m[col], m[piv] = m[piv], m[col]
		inv := new(big.Rat).Inv(m[col][col])
		for j := col; j <= n; j++ {
			m[col][j].Mul(m[col][j], inv)
		}
		for r := 0; r < n; r++ {
			if r == col || m[r][col].Sign() == 0 {
				continue
			}
			f := new(big.Rat).Set(m[r][col])
			for j := col; j <= n; j++ {
				m[r][j].Sub(m[r][j], new(big.Rat).Mul(f, m[col][j]))
			}
		}
	}
	x := make([]*big.Rat, n)
	for i := range x {
		x[i] = m[i][n]
	}
	return x, nil
}
