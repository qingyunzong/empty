// Package cert independently verifies order-preserving projection certificates.
//
// The checker is deliberately separate from the optimizer: it only consumes
// the raw inputs, the candidate x and the candidate edge multipliers. It never
// imports or invokes the solver and never trusts any cached success flag.
// Every condition is recomputed exactly with math/big:
//
//   - input ranges (node IDs, non-nil rational y and strictly positive w)
//   - edge validity (known endpoints, no self loop, acyclic graph)
//   - presence and non-negativity of every multiplier
//   - primal feasibility x_u <= x_v on every edge
//   - complementarity lambda_e * (x_u - x_v) = 0
//   - stationarity
//     2 w_i (x_i-y_i) + sum_{i->v} lambda - sum_{u->i} lambda = 0
//   - exact recomputation of F = sum w_i (x_i-y_i)^2
//
// Duplicate (u,v) edges share one de-duplicated multiplier; their separately
// reported values must agree and the multiplier is counted once, matching the
// unique constraint rather than double-counting the same inequality.
package cert

import (
	"errors"
	"fmt"
	"math/big"
)

// MaxNodes mirrors the optimizer's supported observation count.
const MaxNodes = 64

// Edge is a raw precedence edge as supplied to the calibration host.
type Edge struct {
	EdgeID string
	From   string
	To     string
}

// Certificate is everything the checker needs; nothing here is trusted as a
// precomputed success marker.
type Certificate struct {
	NodeIDs []string
	Y       []*big.Rat
	W       []*big.Rat
	Edges   []Edge
	// X maps node ID to the claimed optimal value.
	X map[string]*big.Rat
	// Lambda maps every original edge ID to its non-negative multiplier.
	Lambda map[string]*big.Rat
	// F is the claimed objective value; it is always recomputed and compared.
	F *big.Rat
}

type uniqueEdge struct {
	from      int
	to        int
	sourceIDs []string
	lambda    *big.Rat
}

// Verify returns nil exactly when the certificate satisfies every condition,
// otherwise an error naming the first failed check.
func Verify(c Certificate) error {
	n := len(c.NodeIDs)
	if n > MaxNodes {
		return fmt.Errorf("cert: at most %d nodes allowed, got %d", MaxNodes, n)
	}
	if len(c.Y) != n || len(c.W) != n {
		return fmt.Errorf("cert: Y and W must each have length %d", n)
	}

	index := make(map[string]int, n)
	for i, id := range c.NodeIDs {
		if id == "" {
			return errors.New("cert: node ID must not be empty")
		}
		if _, dup := index[id]; dup {
			return fmt.Errorf("cert: duplicate node ID %q", id)
		}
		if c.Y[i] == nil {
			return fmt.Errorf("cert: Y for node %q must not be nil", id)
		}
		if c.W[i] == nil {
			return fmt.Errorf("cert: W for node %q must not be nil", id)
		}
		if c.W[i].Sign() <= 0 {
			return fmt.Errorf("cert: W for node %q must be strictly positive", id)
		}
		index[id] = i
	}

	if c.X == nil {
		return errors.New("cert: X map must not be nil")
	}
	if len(c.X) != n {
		return fmt.Errorf("cert: X must contain exactly %d entries, got %d", n, len(c.X))
	}
	xv := make([]*big.Rat, n)
	for id, val := range c.X {
		i, ok := index[id]
		if !ok {
			return fmt.Errorf("cert: X contains unknown node %q", id)
		}
		if val == nil {
			return fmt.Errorf("cert: X for node %q must not be nil", id)
		}
		xv[i] = new(big.Rat).Set(val)
	}

	if c.Lambda == nil {
		return errors.New("cert: lambda map must not be nil")
	}

	pairIndex := make(map[[2]int]int)
	var uniq []uniqueEdge
	seenEdgeID := make(map[string]struct{})
	adj := make([][]int, n)
	indeg := make([]int, n)
	for _, e := range c.Edges {
		if e.EdgeID == "" {
			return errors.New("cert: edge ID must not be empty")
		}
		if _, dup := seenEdgeID[e.EdgeID]; dup {
			return fmt.Errorf("cert: duplicate edge ID %q", e.EdgeID)
		}
		seenEdgeID[e.EdgeID] = struct{}{}

		u, okU := index[e.From]
		if !okU {
			return fmt.Errorf("cert: edge %q references unknown node %q", e.EdgeID, e.From)
		}
		v, okV := index[e.To]
		if !okV {
			return fmt.Errorf("cert: edge %q references unknown node %q", e.EdgeID, e.To)
		}
		if u == v {
			return fmt.Errorf("cert: edge %q is a self loop", e.EdgeID)
		}
		lam, present := c.Lambda[e.EdgeID]
		if !present {
			return fmt.Errorf("cert: missing multiplier for edge %q", e.EdgeID)
		}
		if lam == nil {
			return fmt.Errorf("cert: multiplier for edge %q must not be nil", e.EdgeID)
		}
		if lam.Sign() < 0 {
			return fmt.Errorf("cert: multiplier for edge %q is negative: %s", e.EdgeID, lam.RatString())
		}

		key := [2]int{u, v}
		if k, merged := pairIndex[key]; merged {
			if lam.Cmp(uniq[k].lambda) != 0 {
				return fmt.Errorf("cert: duplicate edge %q reports a different multiplier than its merged pair", e.EdgeID)
			}
			uniq[k].sourceIDs = append(uniq[k].sourceIDs, e.EdgeID)
			continue
		}
		pairIndex[key] = len(uniq)
		uniq = append(uniq, uniqueEdge{
			from:      u,
			to:        v,
			sourceIDs: []string{e.EdgeID},
			lambda:    new(big.Rat).Set(lam),
		})
		adj[u] = append(adj[u], v)
		indeg[v]++
	}
	if len(c.Lambda) != len(seenEdgeID) {
		return errors.New("cert: lambda contains multipliers for unknown edges")
	}

	if err := requireAcyclic(adj, indeg, n); err != nil {
		return err
	}

	// Primal feasibility and complementarity on every unique edge.
	for k, e := range uniq {
		if xv[e.from].Cmp(xv[e.to]) > 0 {
			return fmt.Errorf("cert: primal feasibility violated on edge %v: %s > %s",
				e.sourceIDs, xv[e.from].RatString(), xv[e.to].RatString())
		}
		gap := new(big.Rat).Sub(xv[e.from], xv[e.to])
		product := new(big.Rat).Mul(e.lambda, gap)
		if product.Sign() != 0 {
			return fmt.Errorf("cert: complementarity violated on edge %v", e.sourceIDs)
		}
		_ = k
	}

	// Stationarity at every node over unique edges.
	outSum := make([]*big.Rat, n)
	inSum := make([]*big.Rat, n)
	for i := range outSum {
		outSum[i] = new(big.Rat)
		inSum[i] = new(big.Rat)
	}
	for _, e := range uniq {
		outSum[e.from].Add(outSum[e.from], e.lambda)
		inSum[e.to].Add(inSum[e.to], e.lambda)
	}
	for i := 0; i < n; i++ {
		residual := new(big.Rat).Mul(big.NewRat(2, 1), new(big.Rat).Mul(c.W[i], new(big.Rat).Sub(xv[i], c.Y[i])))
		residual.Add(residual, outSum[i])
		residual.Sub(residual, inSum[i])
		if residual.Sign() != 0 {
			return fmt.Errorf("cert: stationarity violated at node %q", c.NodeIDs[i])
		}
	}

	// Independently recompute the objective.
	recomputed := new(big.Rat)
	for i := 0; i < n; i++ {
		delta := new(big.Rat).Sub(xv[i], c.Y[i])
		recomputed.Add(recomputed, new(big.Rat).Mul(c.W[i], new(big.Rat).Mul(delta, delta)))
	}
	if c.F == nil || recomputed.Cmp(c.F) != 0 {
		claimed := "<nil>"
		if c.F != nil {
			claimed = c.F.RatString()
		}
		return fmt.Errorf("cert: objective mismatch: recomputed %s but claimed %s",
			recomputed.RatString(), claimed)
	}
	return nil
}

func requireAcyclic(adj [][]int, indeg []int, n int) error {
	queue := make([]int, 0, n)
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	seen := 0
	for head := 0; head < len(queue); head++ {
		u := queue[head]
		seen++
		for _, v := range adj[u] {
			indeg[v]--
			if indeg[v] == 0 {
				queue = append(queue, v)
			}
		}
	}
	if seen != n {
		return errors.New("cert: constraint graph contains a cycle")
	}
	return nil
}
