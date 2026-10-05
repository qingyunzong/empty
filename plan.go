package dagcache

import (
	"fmt"
	"math"
	"strings"
)

// Step describes one served demand in a plan.
type Step struct {
	Demand     int   // demanded node index
	Recomputed []int // nodes (re)computed to serve this demand
	StepCost   int64 // compute fee paid at this step
	Cache      []int // cache contents after this step (the planner's decision)
	CacheSize  int64 // total space used by Cache
	Cumulative int64 // total compute fee up to and including this step
}

// Plan is the result of optimal cache planning.
type Plan struct {
	Steps     []Step
	TotalCost int64
}

// OptimalPlan computes the minimum total compute fee for serving demands in
// the given fixed order, deciding after each step which available products to
// keep in a cache of at most budget space.
//
// After serving a demand, any product that is cached or was just recomputed
// may be kept; eviction and storage are free, only compute fees count. The
// search is an exact memoized dynamic program over (step, cache bitmask).
func (g *Graph) OptimalPlan(demands []int, budget int64) (Plan, error) {
	if err := g.checkInputs(demands, budget); err != nil {
		return Plan{}, err
	}

	type choice struct {
		prev  uint64 // cache mask before this step
		cache uint64 // cache mask kept after this step
	}
	// layers[i] maps cache-mask-after-step-i -> best cost so far.
	layers := make([]map[uint64]int64, len(demands)+1)
	parents := make([]map[uint64]choice, len(demands)+1)
	layers[0] = map[uint64]int64{0: 0}
	parents[0] = map[uint64]choice{}

	for i, d := range demands {
		next := map[uint64]int64{}
		parent := map[uint64]choice{}
		for mask, base := range layers[i] {
			recomp, cost := g.recompute(mask, d)
			available := mask | recomp
			submasks(available, func(sub uint64) {
				if g.sizeOf(sub) > budget {
					return
				}
				total := base + cost
				// Deterministic tie-break: prefer the numerically smaller
				// cache mask so equal-cost plans are reproducible.
				if cur, ok := next[sub]; !ok || total < cur || (total == cur && mask < parent[sub].prev) {
					next[sub] = total
					parent[sub] = choice{prev: mask, cache: sub}
				}
			})
		}
		layers[i+1] = next
		parents[i+1] = parent
	}

	bestCost := int64(math.MaxInt64)
	var bestMask uint64
	for mask, cost := range layers[len(demands)] {
		if cost < bestCost || (cost == bestCost && mask < bestMask) {
			bestCost, bestMask = cost, mask
		}
	}

	// Reconstruct decisions backwards, then fill in per-step details.
	caches := make([]uint64, len(demands)+1)
	caches[len(demands)] = bestMask
	for i := len(demands); i > 0; i-- {
		caches[i-1] = parents[i][caches[i]].prev
	}

	plan := Plan{TotalCost: bestCost}
	var cumulative int64
	for i, d := range demands {
		recomp, cost := g.recompute(caches[i], d)
		cumulative += cost
		plan.Steps = append(plan.Steps, Step{
			Demand:     d,
			Recomputed: maskToIndices(recomp),
			StepCost:   cost,
			Cache:      maskToIndices(caches[i+1]),
			CacheSize:  g.sizeOf(caches[i+1]),
			Cumulative: cumulative,
		})
	}
	return plan, nil
}

// Simulate independently replays a demand sequence with prescribed cache
// decisions (cache mask after each step) and returns the total compute fee.
// It verifies that every decision only keeps products that were cached or
// just recomputed, and that the cache never exceeds budget. It is used to
// cross-check plans produced by OptimalPlan.
func (g *Graph) Simulate(demands []int, caches []uint64, budget int64) (int64, error) {
	if err := g.checkInputs(demands, budget); err != nil {
		return 0, err
	}
	if len(caches) != len(demands) {
		return 0, fmt.Errorf("dagcache: got %d cache decisions for %d demands", len(caches), len(demands))
	}
	var cached uint64
	var total int64
	for i, d := range demands {
		recomp, cost := g.recompute(cached, d)
		available := cached | recomp
		keep := caches[i]
		if keep & ^available != 0 {
			return 0, fmt.Errorf("dagcache: step %d caches products that were not available", i)
		}
		if g.sizeOf(keep) > budget {
			return 0, fmt.Errorf("dagcache: step %d cache exceeds budget %d", i, budget)
		}
		total += cost
		cached = keep
	}
	return total, nil
}

// FormatPlan renders the plan as a per-step table of cache states.
func (g *Graph) FormatPlan(p Plan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%-5s %-10s %-18s %-8s %-18s %-9s %s\n",
		"step", "demand", "recomputed", "fee", "cache-after", "cache-sz", "cumulative")
	for i, s := range p.Steps {
		fmt.Fprintf(&b, "%-5d %-10s %-18s %-8d %-18s %-9d %d\n",
			i, g.Nodes[s.Demand].Name,
			strings.Join(g.nodeNames(s.Recomputed), ","),
			s.StepCost,
			strings.Join(g.nodeNames(s.Cache), ","),
			s.CacheSize, s.Cumulative)
	}
	fmt.Fprintf(&b, "total compute fee: %d\n", p.TotalCost)
	return b.String()
}

func (g *Graph) nodeNames(idx []int) []string {
	if len(idx) == 0 {
		return []string{"-"}
	}
	out := make([]string, len(idx))
	for i, v := range idx {
		out[i] = g.Nodes[v].Name
	}
	return out
}

func (g *Graph) checkInputs(demands []int, budget int64) error {
	if err := g.Validate(); err != nil {
		return err
	}
	if len(demands) > MaxDemands {
		return ErrTooManyDemands
	}
	if budget < 0 {
		return fmt.Errorf("dagcache: negative budget %d", budget)
	}
	for i, d := range demands {
		if d < 0 || d >= len(g.Nodes) {
			return fmt.Errorf("dagcache: demand %d index %d out of range", i, d)
		}
	}
	return nil
}

func maskToIndices(mask uint64) []int {
	out := []int{}
	for i := 0; mask != 0; i++ {
		if mask&1 == 1 {
			out = append(out, i)
		}
		mask >>= 1
	}
	return out
}
