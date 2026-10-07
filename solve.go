package recipe

import "math/big"

// Solve runs an exact depth-first branch-and-bound over the integer
// quantity space. Every comparison uses cross-multiplied big integers.
//
// Objective: minimise exact cost, then the number of ingredient types.
//
// If the node Budget is exhausted before the search completes, Solve
// stops and reports certified bounds: Lower is the minimum accumulated
// cost over the live DFS frontier (a valid lower bound on the optimum
// because costs are non-negative and non-decreasing along any path),
// Upper is the cost of the best feasible recipe found so far.
func Solve(p *Problem) *Result {
	if err := p.Validate(); err != nil {
		panic(err)
	}
	n := len(p.Ingredients)
	k := len(p.NutrientNames)

	res := &Result{Lower: ratInt(0)}
	qty := make([]int, n)

	// Incremental exact accumulators along the DFS path.
	cost := ratInt(0)
	weight := ratInt(0)
	nut := [NumScenarios][]*big.Rat{}
	for s := 0; s < NumScenarios; s++ {
		nut[s] = make([]*big.Rat, k)
		for j := range nut[s] {
			nut[s][j] = ratInt(0)
		}
	}
	types := 0

	// Lower-bound certificate: minimum accumulated cost on the live
	// recursion stack at the moment the budget runs out.
	stackCosts := []*big.Rat{ratInt(0)}
	frontierMin := func() *big.Rat {
		m := stackCosts[0]
		for _, c := range stackCosts[1:] {
			if ltRat(c, m) {
				m = c
			}
		}
		return cloneRat(m)
	}

	var dfs func(i int) bool // returns true to abort (budget exhausted)
	dfs = func(i int) bool {
		res.Nodes++
		if p.Budget > 0 && res.Nodes > p.Budget {
			res.Exhausted = true
			res.Lower = frontierMin()
			return true
		}
		if i == n {
			// Leaf: lower-bound sides (upper sides were pruned already).
			if ltRat(weight, p.WeightLo) {
				return false
			}
			for s := 0; s < NumScenarios; s++ {
				for j := 0; j < k; j++ {
					if ltRat(nut[s][j], p.NutLo[j]) {
						return false
					}
				}
			}
			order, ok := TopoOrder(usedIndices(qty), p.Prec)
			if !ok {
				return false
			}
			cand := &Solution{
				Qty:    append([]int(nil), qty...),
				Types:  types,
				Cost:   cloneRat(cost),
				Weight: cloneRat(weight),
				Order:  order,
			}
			for s := 0; s < NumScenarios; s++ {
				cand.Nutrients[s] = make([]*big.Rat, k)
				for j := range nut[s] {
					cand.Nutrients[s][j] = cloneRat(nut[s][j])
				}
			}
			if better(cand, res.Best) {
				res.Best = cand
			}
			return false
		}

		ing := &p.Ingredients[i]
		for q := 0; q <= p.MaxUnits; q++ {
			if q > 0 {
				if types+1 > p.MaxTypes {
					break
				}
				conflict := false
				for _, pair := range p.Mutex {
					if (pair[0] == i && qty[pair[1]] > 0) || (pair[1] == i && qty[pair[0]] > 0) {
						conflict = true
						break
					}
				}
				if conflict {
					break
				}
			}

			qRat := ratInt(int64(q))
			addCost := new(big.Rat).Mul(qRat, ing.Cost)
			addWeight := new(big.Rat).Mul(qRat, ing.Weight)
			cost.Add(cost, addCost)
			weight.Add(weight, addWeight)
			for s := 0; s < NumScenarios; s++ {
				for j := 0; j < k; j++ {
					nut[s][j].Add(nut[s][j], new(big.Rat).Mul(qRat, ing.Pot[s][j]))
				}
			}
			qty[i] = q
			if q > 0 {
				types++
			}

			// Prune only on monotone (non-negative) directions.
			prune := gtRat(weight, p.WeightHi)
			if !prune {
				for s := 0; s < NumScenarios && !prune; s++ {
					for j := 0; j < k; j++ {
						if gtRat(nut[s][j], p.NutHi[j]) {
							prune = true
							break
						}
					}
				}
			}
			if !prune && res.Best != nil {
				// Cost already exceeds the incumbent; ties cannot win
				// because types only grow deeper in the tree.
				if cmpRat(cost, res.Best.Cost) > 0 ||
					(cmpRat(cost, res.Best.Cost) == 0 && types >= res.Best.Types) {
					prune = true
				}
			}

			abort := false
			if !prune {
				stackCosts = append(stackCosts, cloneRat(cost))
				abort = dfs(i + 1)
				stackCosts = stackCosts[:len(stackCosts)-1]
			}

			if q > 0 {
				types--
			}
			qty[i] = 0
			cost.Sub(cost, addCost)
			weight.Sub(weight, addWeight)
			for s := 0; s < NumScenarios; s++ {
				for j := 0; j < k; j++ {
					nut[s][j].Sub(nut[s][j], new(big.Rat).Mul(qRat, ing.Pot[s][j]))
				}
			}
			if abort {
				return true
			}
		}
		return false
	}

	if dfs(0) {
		// Budget exhausted: Lower was captured at the frontier.
	} else {
		res.Optimal = true
		if res.Best != nil {
			res.Lower = cloneRat(res.Best.Cost)
		}
	}
	if res.Best != nil {
		res.Upper = cloneRat(res.Best.Cost)
	}
	return res
}
