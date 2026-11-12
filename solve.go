package dataeng

import (
	"errors"
	"fmt"
	"math/big"
)

// Solve projects the weighted observations onto the compiled partial order.
//
// The graph is reused unchanged; y and w may differ across calls. Inputs are
// revalidated (lengths, nil values, strictly positive weights) and copied, so
// later mutations of the caller's slices cannot affect the solve or its
// result. The returned [Result] holds exact rationals only.
func (g *Graph) Solve(y []*big.Rat, w []*big.Rat) (*Result, error) {
	n := g.N()
	if len(y) != n || len(w) != n {
		return nil, fmt.Errorf("dataeng: y and w must each have length %d", n)
	}
	yy := make([]*big.Rat, n)
	ww := make([]*big.Rat, n)
	for i := 0; i < n; i++ {
		if y[i] == nil {
			return nil, fmt.Errorf("dataeng: observation y for %q must not be nil", g.ids[i])
		}
		if w[i] == nil {
			return nil, fmt.Errorf("dataeng: weight w for %q must not be nil", g.ids[i])
		}
		if w[i].Sign() <= 0 {
			return nil, fmt.Errorf("dataeng: weight w for %q must be strictly positive", g.ids[i])
		}
		yy[i] = ratCopy(y[i])
		ww[i] = ratCopy(w[i])
	}

	if n == 0 {
		return &Result{
			x:      []*big.Rat{},
			f:      new(big.Rat),
			lambda: []*big.Rat{},
			graph:  g,
		}, nil
	}

	blockOf, blockNodes, flowCalls, splitCount := g.refineBlocks(yy, ww)

	x := make([]*big.Rat, n)
	for _, members := range blockNodes {
		mean := weightedMean(members, yy, ww)
		for _, node := range members {
			x[node] = ratCopy(mean)
		}
	}

	if err := checkBlockOrdering(g, x); err != nil {
		return nil, err
	}

	lambda, flowUsed, err := g.blockMultipliers(blockOf, blockNodes, x, yy, ww)
	if err != nil {
		return nil, err
	}
	flowCalls += flowUsed

	return &Result{
		x:      x,
		f:      objective(yy, ww, x),
		lambda: lambda,
		flow:   flowCalls,
		splits: splitCount,
		blocks: len(blockNodes),
		graph:  g,
	}, nil
}

// refineBlocks implements the finite closed-set cut algorithm.
//
// Every block is kept only while its pooled weighted mean is optimal on the
// induced sub-poset. The stationarity residual a_i = w_i (mean-y_i) has zero
// total over a block; a minimum-weight lower-closed subset with strictly
// negative weight is an exact certificate that the pool must be split. A split
// replaces one block by two, so the block count strictly increases and is
// bounded by n; consequently the algorithm terminates after at most n-1
// refinement splits (and the same number of flow calls for refinement, plus
// one feasibility flow per block when recovering multipliers).
func (g *Graph) refineBlocks(y, w []*big.Rat) ([]int, [][]int, int, int) {
	n := g.N()
	all := make([]int, n)
	for i := 0; i < n; i++ {
		all[i] = i
	}
	// active holds the current partition. Each queue entry is an index into
	// active; splitting replaces that entry in place and enqueues both children.
	active := [][]int{all}
	queue := []int{0}

	flowCalls := 0
	splits := 0
	for head := 0; head < len(queue); head++ {
		blockID := queue[head]
		members := active[blockID]
		if len(members) == 1 {
			continue
		}
		mean := weightedMean(members, y, w)
		residual := make([]*big.Rat, n)
		for _, i := range members {
			// w_i * (mean - y_i).
			residual[i] = ratMul(w[i], ratSub(mean, y[i]))
		}
		flowCalls++
		closure := minWeightLowerClosure(g, members, residual)
		if !ratIsNegative(closure.weight) {
			continue
		}

		lower := make([]int, 0, len(members))
		upper := make([]int, 0, len(members))
		for _, i := range members {
			if closure.inside[i] {
				lower = append(lower, i)
			} else {
				upper = append(upper, i)
			}
		}
		if len(lower) == 0 || len(upper) == 0 {
			// Defensive: zero-sum residual makes the full set weight zero, so a
			// strictly negative closure can never be empty or the whole block.
			continue
		}
		splits++
		// Replace the refined block with its lower child in place and append the
		// upper child; both indices join the work queue.
		lowerID := blockID
		upperID := len(active)
		active[lowerID] = lower
		active = append(active, upper)
		queue = append(queue, lowerID, upperID)
	}

	blockOf := make([]int, n)
	for blockID, group := range active {
		for _, node := range group {
			blockOf[node] = blockID
		}
	}
	return blockOf, active, flowCalls, splits
}

// blockMultipliers recovers non-negative KKT multipliers through one feasible
// flow per block. Across different blocks every edge is non-tight and must
// carry zero, which is already guaranteed by only routing induced edges.
func (g *Graph) blockMultipliers(blockOf []int, blockNodes [][]int, x, y, w []*big.Rat) ([]*big.Rat, int, error) {
	n := g.N()
	lambda := make([]*big.Rat, len(g.edges))
	for k := range lambda {
		lambda[k] = new(big.Rat)
	}

	flowCalls := 0
	for _, members := range blockNodes {
		if len(members) == 1 {
			// Stationarity for an isolated block has all multipliers zero.
			if got := ratMul(w[members[0]], ratSub(x[members[0]], y[members[0]])); got.Sign() != 0 {
				return nil, 0, fmt.Errorf("dataeng: internal error: singleton block not at observation")
			}
			continue
		}

		balance := make([]*big.Rat, n)
		totalSupply := new(big.Rat)
		for _, i := range members {
			// Stationarity needs outgoing - incoming = 2 w_i (y_i - x_i).
			balance[i] = ratMul(new(big.Rat).SetInt64(2), ratMul(w[i], ratSub(y[i], x[i])))
			if balance[i].Sign() > 0 {
				totalSupply.Add(totalSupply, balance[i])
			}
		}

		local := make([]int, n)
		for i := range local {
			local[i] = -1
		}
		for k, global := range members {
			local[global] = k
		}
		source := len(members)
		sink := source + 1
		dinic := newRationalDinic(len(members) + 2)

		// Remember which forward network arc corresponds to each unique edge.
		edgeArc := make([]int, len(g.edges))
		for k := range edgeArc {
			edgeArc[k] = -1
		}
		inf := ratSum(totalSupply, big.NewRat(1, 1))
		for edgeK, e := range g.edges {
			if local[e.from] >= 0 && local[e.to] >= 0 {
				edgeArc[edgeK] = len(dinic.graph[local[e.from]])
				dinic.addEdge(local[e.from], local[e.to], inf)
			}
		}
		for _, i := range members {
			switch balance[i].Sign() {
			case 1:
				dinic.addEdge(source, local[i], balance[i])
			case -1:
				dinic.addEdge(local[i], sink, new(big.Rat).Neg(balance[i]))
			}
		}

		flowCalls++
		flow := dinic.maxFlow(source, sink)
		if flow.Cmp(totalSupply) != 0 {
			return nil, 0, errors.New("dataeng: internal error: KKT feasibility flow could not be satisfied")
		}
		for edgeK, arc := range edgeArc {
			if arc < 0 {
				continue
			}
			from := g.edges[edgeK].from
			lambda[edgeK] = dinic.arcFlow(local[from], arc)
			if lambda[edgeK].Sign() < 0 {
				return nil, 0, errors.New("dataeng: internal error: negative multiplier produced")
			}
		}
	}
	return lambda, flowCalls, nil
}

// weightedMean returns (sum w_i y_i)/(sum w_i) exactly.
func weightedMean(nodes []int, y, w []*big.Rat) *big.Rat {
	num := new(big.Rat)
	den := new(big.Rat)
	for _, i := range nodes {
		num.Add(num, ratMul(w[i], y[i]))
		den.Add(den, w[i])
	}
	return num.Quo(num, den)
}

// objective recomputes the exact squared weighted error.
func objective(y, w, x []*big.Rat) *big.Rat {
	f := new(big.Rat)
	for i := range y {
		delta := ratSub(x[i], y[i])
		f.Add(f, ratMul(w[i], ratMul(delta, delta)))
	}
	return f
}

// checkBlockOrdering verifies the projection respects every original edge.
// Block identifiers carry no ordering information, so the check uses values.
func checkBlockOrdering(g *Graph, x []*big.Rat) error {
	for _, e := range g.edges {
		if x[e.from].Cmp(x[e.to]) > 0 {
			return errors.New("dataeng: internal error: projection violates an edge constraint")
		}
	}
	return nil
}
