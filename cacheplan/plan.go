// Package cacheplan plans shared intermediate-artifact caching over a
// dependency DAG. Cached artifacts occupy space but save recomputation
// for later demands. Given a fixed demand sequence (at most MaxDemands
// steps) and a cache space budget, Plan finds the minimum total compute
// cost and reports the cache state after every step.
package cacheplan

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// MaxDemands is the maximum supported demand-sequence length.
const MaxDemands = 20

// maxNodes caps the DAG size because states are enumerated as bitmasks.
const maxNodes = 24

// Node is one computable artifact in the dependency DAG.
type Node struct {
	Name string // human-readable label
	Cost int    // compute cost paid when the artifact is (re)computed
	Size int    // cache space occupied while the artifact is cached
	Deps []int  // indices of nodes that must be available to compute this one
}

// Graph is a dependency DAG; edges point from a node to its dependencies.
type Graph struct {
	Nodes []Node
}

// Step describes one served demand and the resulting cache state.
type Step struct {
	Demand   int   // demanded node index
	Computed []int // nodes (re)computed during this step, sorted
	Cost     int   // compute cost paid during this step
	Cache    []int // cache contents after this step, sorted
}

// Plan is the full schedule: per-step cache states plus total cost.
type Plan struct {
	TotalCost int
	Steps     []Step
}

// Validate checks structural invariants of the DAG.
func (g *Graph) Validate() error {
	n := len(g.Nodes)
	if n == 0 {
		return errors.New("cacheplan: empty graph")
	}
	if n > maxNodes {
		return fmt.Errorf("cacheplan: %d nodes exceeds limit %d", n, maxNodes)
	}
	for i, nd := range g.Nodes {
		if nd.Cost < 0 {
			return fmt.Errorf("cacheplan: node %d has negative cost", i)
		}
		if nd.Size < 0 {
			return fmt.Errorf("cacheplan: node %d has negative size", i)
		}
		for _, d := range nd.Deps {
			if d < 0 || d >= n {
				return fmt.Errorf("cacheplan: node %d has out-of-range dep %d", i, d)
			}
			if d == i {
				return fmt.Errorf("cacheplan: node %d depends on itself", i)
			}
		}
	}
	if _, err := g.closures(); err != nil {
		return err
	}
	return nil
}

// closures returns, per node, the bitmask of itself plus transitive deps.
func (g *Graph) closures() ([]uint64, error) {
	n := len(g.Nodes)
	clo := make([]uint64, n)
	visiting := make([]bool, n)
	done := make([]bool, n)
	var visit func(i int) error
	visit = func(i int) error {
		if done[i] {
			return nil
		}
		if visiting[i] {
			return fmt.Errorf("cacheplan: dependency cycle at node %d", i)
		}
		visiting[i] = true
		m := uint64(1) << uint(i)
		for _, d := range g.Nodes[i].Deps {
			if err := visit(d); err != nil {
				return err
			}
			m |= clo[d]
		}
		visiting[i] = false
		done[i] = true
		clo[i] = m
		return nil
	}
	for i := 0; i < n; i++ {
		if err := visit(i); err != nil {
			return nil, err
		}
	}
	return clo, nil
}

func maskCost(g *Graph, m uint64) int {
	total := 0
	for m != 0 {
		i := bitsTrailing(m)
		total += g.Nodes[i].Cost
		m &= m - 1
	}
	return total
}

func maskSize(g *Graph, m uint64) int {
	total := 0
	for m != 0 {
		i := bitsTrailing(m)
		total += g.Nodes[i].Size
		m &= m - 1
	}
	return total
}

func maskList(m uint64) []int {
	var out []int
	for m != 0 {
		i := bitsTrailing(m)
		out = append(out, i)
		m &= m - 1
	}
	return out
}

func bitsTrailing(m uint64) int {
	n := 0
	for m&1 == 0 {
		m >>= 1
		n++
	}
	return n
}

func checkInputs(g *Graph, demands []int, budget int) ([]uint64, error) {
	if err := g.Validate(); err != nil {
		return nil, err
	}
	if len(demands) == 0 {
		return nil, errors.New("cacheplan: empty demand sequence")
	}
	if len(demands) > MaxDemands {
		return nil, fmt.Errorf("cacheplan: %d demands exceeds limit %d", len(demands), MaxDemands)
	}
	if budget < 0 {
		return nil, errors.New("cacheplan: negative budget")
	}
	for _, d := range demands {
		if d < 0 || d >= len(g.Nodes) {
			return nil, fmt.Errorf("cacheplan: demand %d out of range", d)
		}
	}
	return g.closures()
}

// subsetsWithin yields every submask of avail whose total size fits budget.
func subsetsWithin(g *Graph, avail uint64, budget int, yield func(uint64)) {
	var rec func(rest, chosen uint64, size int)
	rec = func(rest, chosen uint64, size int) {
		if rest == 0 {
			yield(chosen)
			return
		}
		i := bitsTrailing(rest)
		bit := uint64(1) << uint(i)
		rest &= rest - 1
		rec(rest, chosen, size) // skip i
		if s := size + g.Nodes[i].Size; s <= budget {
			rec(rest, chosen|bit, s) // take i
		}
	}
	rec(avail, 0, 0)
}

// Optimize computes the minimum total compute cost for serving demands in
// order, starting from an empty cache, never exceeding budget cached
// space. It uses exact dynamic programming over cache-state bitmasks.
func Optimize(g *Graph, demands []int, budget int) (*Plan, error) {
	clo, err := checkInputs(g, demands, budget)
	if err != nil {
		return nil, err
	}
	const inf = int(^uint(0) >> 2)
	// dp maps cache-state mask -> min cost so far.
	dp := map[uint64]int{0: 0}
	parents := make([]map[uint64]uint64, len(demands)) // per step: next -> prev
	for t, d := range demands {
		next := make(map[uint64]int)
		parents[t] = make(map[uint64]uint64)
		for state, cost := range dp {
			avail := state | clo[d]
			stepCost := maskCost(g, clo[d]&^state)
			subsetsWithin(g, avail, budget, func(s uint64) {
				c := cost + stepCost
				if cur, ok := next[s]; !ok || c < cur {
					next[s] = c
					parents[t][s] = state
				}
			})
		}
		dp = next
	}
	best, bestState := inf, uint64(0)
	for state, cost := range dp {
		if cost < best {
			best, bestState = cost, state
		}
	}
	if best == inf {
		return nil, errors.New("cacheplan: no feasible plan")
	}
	// Reconstruct chosen states backwards.
	states := make([]uint64, len(demands)+1)
	states[len(demands)] = bestState
	for t := len(demands) - 1; t >= 0; t-- {
		states[t] = parents[t][states[t+1]]
	}
	p := &Plan{TotalCost: best}
	for t, d := range demands {
		computed := clo[d] &^ states[t]
		p.Steps = append(p.Steps, Step{
			Demand:   d,
			Computed: maskList(computed),
			Cost:     maskCost(g, computed),
			Cache:    maskList(states[t+1]),
		})
	}
	return p, nil
}

// BruteForce independently verifies Plan on small graphs by exhaustive
// recursion over every legal cache decision, with no memoization.
func BruteForce(g *Graph, demands []int, budget int) (int, error) {
	clo, err := checkInputs(g, demands, budget)
	if err != nil {
		return 0, err
	}
	var search func(t int, state uint64) int
	search = func(t int, state uint64) int {
		if t == len(demands) {
			return 0
		}
		d := demands[t]
		stepCost := maskCost(g, clo[d]&^state)
		avail := state | clo[d]
		best := -1
		subsetsWithin(g, avail, budget, func(s uint64) {
			if c := stepCost + search(t+1, s); best < 0 || c < best {
				best = c
			}
		})
		return best
	}
	return search(0, 0), nil
}

// String renders the plan with one line per step, showing recomputed
// nodes, step cost, and the cache state after the step.
func (p *Plan) String(g *Graph) string {
	var b strings.Builder
	names := func(idx []int) string {
		if len(idx) == 0 {
			return "-"
		}
		parts := make([]string, len(idx))
		for i, x := range idx {
			parts[i] = g.Nodes[x].Name
		}
		sort.Strings(parts)
		return strings.Join(parts, ",")
	}
	for t, s := range p.Steps {
		fmt.Fprintf(&b, "step %2d demand=%s computed=[%s] cost=%d cache={%s}\n",
			t+1, g.Nodes[s.Demand].Name, names(s.Computed), s.Cost, names(s.Cache))
	}
	fmt.Fprintf(&b, "total cost = %d\n", p.TotalCost)
	return b.String()
}
