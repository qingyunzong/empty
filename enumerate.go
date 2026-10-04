package transferplan

// Enumerate is the brute-force reference implementation: it enumerates
// every per-edge flow assignment in [0, Cap]^m, keeps the cheapest
// demand-satisfying one, and returns it. It is only practical for
// small instances and exists to cross-check Solve.
func Enumerate(p Problem) (Plan, error) {
	if err := p.Validate(); err != nil {
		return Plan{}, err
	}
	balance := make([]int, p.Nodes)
	flows := make([]int, len(p.Edges))
	bestCost := -1
	var best Plan

	var rec func(k, cost int)
	rec = func(k, cost int) {
		if bestCost >= 0 && cost >= bestCost {
			return // costs are non-negative, cannot improve
		}
		if k == len(p.Edges) {
			for i := range balance {
				if balance[i] > p.Supply[i]-p.Demand[i] {
					return
				}
			}
			bestCost = cost
			best = Plan{Cost: cost, Flows: append([]int(nil), flows...)}
			return
		}
		e := p.Edges[k]
		for f := 0; f <= e.Cap; f++ {
			arrived := 0
			if f > 0 {
				if f < e.Loss {
					continue
				}
				arrived = f - e.Loss
			}
			balance[e.From] += f
			balance[e.To] -= arrived
			flows[k] = f
			rec(k+1, cost+f*e.Cost)
			balance[e.From] -= f
			balance[e.To] += arrived
		}
		flows[k] = 0
	}
	rec(0, 0)

	if bestCost < 0 {
		return Plan{}, ErrInfeasible
	}
	return best, nil
}
