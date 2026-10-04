package pipenet

import (
	"fmt"
	"math/big"
)

// Violation describes one failed exact equation, with the nonzero
// rational residual as evidence.
type Violation struct {
	Equation string
	Residual *big.Rat
}

// Report collects every equation violated by a candidate Solution.
type Report struct {
	Violations []Violation
}

// OK reports whether all checked equations hold exactly.
func (r *Report) OK() bool { return len(r.Violations) == 0 }

func (r *Report) fail(eq string, res *big.Rat) {
	r.Violations = append(r.Violations, Violation{Equation: eq, Residual: res})
}

// Check independently verifies a candidate Solution against the raw
// network equations, using exact rational arithmetic. It shares no
// state with Solve: components are recomputed by BFS and every
// residual is accumulated directly from the edge list.
//
// Verified equations:
//   - resistance:  p_U - p_V - R_e*q_e == 0 for every edge e
//   - conservation: net pipe outflow at node i == specified injection
//     (Injection nodes), and == Injections[i] where supplied
//   - head:        p_i == specified head (Head nodes)
//   - null space:  each basis vector v is nonzero, constant on every
//     edge (flows unchanged), lies in ker L, and every unanchored
//     component is covered by exactly one basis vector
func Check(net *Network, sol *Solution) *Report {
	rep := &Report{}
	n := len(net.Nodes)
	if len(sol.Pressures) != n || len(sol.Injections) != n {
		rep.fail("shape: Pressures/Injections length", big.NewRat(1, 1))
		return rep
	}
	if len(sol.Flows) != len(net.Edges) {
		rep.fail("shape: Flows length", big.NewRat(1, 1))
		return rep
	}
	for _, vec := range sol.NullSpace {
		if len(vec) != n {
			rep.fail("shape: null-space vector length", big.NewRat(1, 1))
			return rep
		}
	}

	// Resistance law per edge.
	for e, ed := range net.Edges {
		res := new(big.Rat).Sub(sol.Pressures[ed.U], sol.Pressures[ed.V])
		res.Sub(res, new(big.Rat).Mul(ed.R, sol.Flows[e]))
		if res.Sign() != 0 {
			rep.fail(fmt.Sprintf("resistance: edge %d (%d->%d)", e, ed.U, ed.V), res)
		}
	}

	// Conservation per node: net outflow through incident pipes.
	netOut := make([]*big.Rat, n)
	for i := range netOut {
		netOut[i] = new(big.Rat)
	}
	for e, ed := range net.Edges {
		netOut[ed.U].Add(netOut[ed.U], sol.Flows[e])
		netOut[ed.V].Sub(netOut[ed.V], sol.Flows[e])
	}
	for i, nd := range net.Nodes {
		switch nd.Kind {
		case Injection:
			res := new(big.Rat).Sub(netOut[i], nd.Value)
			if res.Sign() != 0 {
				rep.fail(fmt.Sprintf("conservation: node %d injection", i), res)
			}
		case Head:
			res := new(big.Rat).Sub(sol.Pressures[i], nd.Value)
			if res.Sign() != 0 {
				rep.fail(fmt.Sprintf("head: node %d", i), res)
			}
		}
		res := new(big.Rat).Sub(netOut[i], sol.Injections[i])
		if res.Sign() != 0 {
			rep.fail(fmt.Sprintf("conservation: node %d reported injection", i), res)
		}
	}

	// Null-space evidence.
	comps := bfsComponents(net)
	for k, v := range sol.NullSpace {
		nonzero := false
		for _, x := range v {
			if x.Sign() != 0 {
				nonzero = true
				break
			}
		}
		if !nonzero {
			rep.fail(fmt.Sprintf("null-space: vector %d is zero", k), big.NewRat(0, 1))
			continue
		}
		for e, ed := range net.Edges {
			res := new(big.Rat).Sub(v[ed.U], v[ed.V])
			if res.Sign() != 0 {
				rep.fail(fmt.Sprintf("null-space: vector %d changes flow on edge %d", k, e), res)
			}
		}
		// L v == 0, accumulated directly from the edge list.
		lv := make([]*big.Rat, n)
		for i := range lv {
			lv[i] = new(big.Rat)
		}
		for _, ed := range net.Edges {
			g := new(big.Rat).Inv(ed.R)
			d := new(big.Rat).Sub(v[ed.U], v[ed.V])
			d.Mul(d, g)
			lv[ed.U].Add(lv[ed.U], d)
			lv[ed.V].Sub(lv[ed.V], d)
		}
		for i, x := range lv {
			if x.Sign() != 0 {
				rep.fail(fmt.Sprintf("null-space: (Lv)[%d] for vector %d", i, k), new(big.Rat).Set(x))
			}
		}
	}
	// Coverage: each unanchored component must be evidenced by exactly
	// one null-space vector equal to its indicator.
	for ci, comp := range comps {
		anchored := false
		for _, i := range comp {
			if net.Nodes[i].Kind == Head {
				anchored = true
				break
			}
		}
		inComp := make([]bool, n)
		for _, i := range comp {
			inComp[i] = true
		}
		matches := 0
		for _, v := range sol.NullSpace {
			if isIndicator(v, inComp) {
				matches++
			}
		}
		if anchored {
			if matches != 0 {
				rep.fail(fmt.Sprintf("null-space: anchored component %d has spurious vector", ci), big.NewRat(1, 1))
			}
		} else if matches != 1 {
			res := big.NewRat(int64(matches), 1)
			rep.fail(fmt.Sprintf("null-space: unanchored component %d evidenced by %d vectors, want 1", ci, matches), res)
		}
	}
	return rep
}

// isIndicator reports whether v equals the 0/1 indicator of the set.
func isIndicator(v []*big.Rat, inSet []bool) bool {
	for i, x := range v {
		want := int64(0)
		if inSet[i] {
			want = 1
		}
		if x.Cmp(big.NewRat(want, 1)) != 0 {
			return false
		}
	}
	return true
}

// bfsComponents recomputes connected components independently of the
// solver's union-find.
func bfsComponents(net *Network) [][]int {
	n := len(net.Nodes)
	adj := make([][]int, n)
	for _, ed := range net.Edges {
		adj[ed.U] = append(adj[ed.U], ed.V)
		adj[ed.V] = append(adj[ed.V], ed.U)
	}
	seen := make([]bool, n)
	var comps [][]int
	for s := 0; s < n; s++ {
		if seen[s] {
			continue
		}
		var comp []int
		queue := []int{s}
		seen[s] = true
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			comp = append(comp, u)
			for _, w := range adj[u] {
				if !seen[w] {
					seen[w] = true
					queue = append(queue, w)
				}
			}
		}
		comps = append(comps, comp)
	}
	return comps
}
