package dagcache

import "math"

// BruteForceCost computes the optimal total compute fee by exhaustive,
// unmemoized enumeration of every feasible cache-decision sequence. It is
// exponential and intended only as an independent reference implementation
// to validate OptimalPlan on small graphs (完整状态搜索验证).
func (g *Graph) BruteForceCost(demands []int, budget int64) (int64, error) {
	if err := g.checkInputs(demands, budget); err != nil {
		return 0, err
	}
	return g.search(demands, budget, 0, 0), nil
}

// search returns the minimum remaining compute fee from step i onward,
// given the current cache contents. No memoization: every decision
// sequence is explored explicitly.
func (g *Graph) search(demands []int, budget int64, i int, cached uint64) int64 {
	if i == len(demands) {
		return 0
	}
	recomp, cost := g.recompute(cached, demands[i])
	available := cached | recomp
	best := int64(math.MaxInt64)
	submasks(available, func(sub uint64) {
		if g.sizeOf(sub) > budget {
			return
		}
		if total := cost + g.search(demands, budget, i+1, sub); total < best {
			best = total
		}
	})
	return best
}
