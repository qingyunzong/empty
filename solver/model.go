// Package solver implements an exact test-selection optimizer.
//
// Problem: given at most 24 tests, each covering a set of public branches
// and pairwise interactions, with startup prerequisites between tests and a
// total time limit, choose a subset that covers every required branch and
// pair. The objective is lexicographic: minimize total cost first, then the
// number of selected tests.
package solver

import (
	"errors"
	"fmt"
	"sort"
)

// MaxTests is the hard limit on the number of tests in an instance.
const MaxTests = 24

// Test describes a single selectable test.
type Test struct {
	ID       string   `json:"id"`
	Cost     int      `json:"cost"`
	Time     int      `json:"time"`
	Requires []string `json:"requires,omitempty"`
	Branches []string `json:"branches,omitempty"`
	Pairs    []string `json:"pairs,omitempty"`
}

// Instance is the full optimization problem.
type Instance struct {
	Name      string   `json:"name"`
	Branches  []string `json:"branches"` // required public branches
	Pairs     []string `json:"pairs"`    // required pairwise interactions
	TimeLimit int      `json:"timeLimit"`
	Tests     []Test   `json:"tests"`
}

// Status is the outcome of a solve.
type Status string

const (
	// Optimal means a feasible selection was found and its objective was
	// proven minimal by the search bound.
	Optimal Status = "OPTIMAL"
	// Infeasible means no selection can cover all requirements within the
	// time limit.
	Infeasible Status = "INFEASIBLE"
	// Feasible means a selection was found but the node budget was exhausted
	// before optimality could be proven; Bound still holds.
	Feasible Status = "FEASIBLE"
	// Unknown means the node budget was exhausted before any feasible
	// selection was found; nothing is proven either way.
	Unknown Status = "UNKNOWN"
)

// bitset is a small fixed-capacity bit vector over requirement indices.
type bitset struct{ w []uint64 }

func newBitset(n int) bitset { return bitset{w: make([]uint64, (n+63)/64)} }

func (b bitset) set(i int)      { b.w[i/64] |= 1 << (uint(i) % 64) }
func (b bitset) has(i int) bool { return b.w[i/64]&(1<<(uint(i)%64)) != 0 }

func (b bitset) unionInto(o bitset) {
	for i := range b.w {
		b.w[i] |= o.w[i]
	}
}

// contains reports whether b is a superset of o.
func (b bitset) contains(o bitset) bool {
	for i := range b.w {
		if b.w[i]&o.w[i] != o.w[i] {
			return false
		}
	}
	return true
}

func (b bitset) count() int {
	n := 0
	for _, w := range b.w {
		for w != 0 {
			w &= w - 1
			n++
		}
	}
	return n
}

// missing returns the number of bits set in req but not in b.
func (b bitset) missingFrom(req bitset) int {
	n := 0
	for i := range b.w {
		w := req.w[i] &^ b.w[i]
		for w != 0 {
			w &= w - 1
			n++
		}
	}
	return n
}

// compiled is the indexed, ready-to-search form of an Instance.
type compiled struct {
	inst *Instance
	n    int

	branchIdx map[string]int
	pairIdx   map[string]int
	reqB      bitset
	reqP      bitset

	// Per-test data, in input order.
	costs  []int
	times  []int
	coverB []bitset
	coverP []bitset

	// closure[i] is the test bitmask (over input order) containing i and
	// all of its transitive prerequisites.
	closure []uint64
	// closureCost/closureTime[i] is the total cost/time of closure[i].
	closureCost []int
	closureTime []int

	// coverersB[coverersP] maps a requirement index to the tests covering it.
	coverersB [][]int
	coverersP [][]int

	// order is the branching order (indices into tests).
	order []int
}

// compile validates the instance and precomputes indexed data.
func compile(inst *Instance) (*compiled, error) {
	if inst == nil {
		return nil, errors.New("nil instance")
	}
	n := len(inst.Tests)
	if n == 0 {
		return nil, errors.New("instance has no tests")
	}
	if n > MaxTests {
		return nil, fmt.Errorf("instance has %d tests, maximum is %d", n, MaxTests)
	}
	if inst.TimeLimit < 0 {
		return nil, fmt.Errorf("negative time limit %d", inst.TimeLimit)
	}

	c := &compiled{
		inst:      inst,
		n:         n,
		branchIdx: map[string]int{},
		pairIdx:   map[string]int{},
		costs:     make([]int, n),
		times:     make([]int, n),
		closure:   make([]uint64, n),
	}

	// Index requirements; duplicates inside the required lists are errors.
	for i, b := range inst.Branches {
		if _, dup := c.branchIdx[b]; dup {
			return nil, fmt.Errorf("duplicate required branch %q", b)
		}
		c.branchIdx[b] = i
	}
	for i, p := range inst.Pairs {
		if _, dup := c.pairIdx[p]; dup {
			return nil, fmt.Errorf("duplicate required pair %q", p)
		}
		c.pairIdx[p] = i
	}
	c.reqB = newBitset(len(inst.Branches))
	for i := range inst.Branches {
		c.reqB.set(i)
	}
	c.reqP = newBitset(len(inst.Pairs))
	for i := range inst.Pairs {
		c.reqP.set(i)
	}

	// Validate tests and index their coverage.
	idIdx := map[string]int{}
	for i, t := range inst.Tests {
		if t.ID == "" {
			return nil, fmt.Errorf("test #%d has empty id", i)
		}
		if _, dup := idIdx[t.ID]; dup {
			return nil, fmt.Errorf("duplicate test id %q", t.ID)
		}
		idIdx[t.ID] = i
		if t.Cost < 0 {
			return nil, fmt.Errorf("test %q has negative cost", t.ID)
		}
		if t.Time < 0 {
			return nil, fmt.Errorf("test %q has negative time", t.ID)
		}
		c.costs[i] = t.Cost
		c.times[i] = t.Time
	}
	c.coverB = make([]bitset, n)
	c.coverP = make([]bitset, n)
	for i, t := range inst.Tests {
		cb := newBitset(len(inst.Branches))
		for _, b := range t.Branches {
			j, ok := c.branchIdx[b]
			if !ok {
				return nil, fmt.Errorf("test %q covers unknown branch %q", t.ID, b)
			}
			cb.set(j)
		}
		c.coverB[i] = cb
		cp := newBitset(len(inst.Pairs))
		for _, p := range t.Pairs {
			j, ok := c.pairIdx[p]
			if !ok {
				return nil, fmt.Errorf("test %q covers unknown pair %q", t.ID, p)
			}
			cp.set(j)
		}
		c.coverP[i] = cp
	}

	// Resolve prerequisites and compute transitive closures. Cycles are
	// allowed: every member of a cycle pulls in the whole cycle.
	for _, t := range inst.Tests {
		for _, r := range t.Requires {
			if _, ok := idIdx[r]; !ok {
				return nil, fmt.Errorf("test %q requires unknown test %q", t.ID, r)
			}
		}
	}
	reqs := make([][]int, n)
	for i, t := range inst.Tests {
		for _, r := range t.Requires {
			reqs[i] = append(reqs[i], idIdx[r])
		}
	}
	for i := 0; i < n; i++ {
		var mask uint64
		stack := []int{i}
		for len(stack) > 0 {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if mask&(1<<uint(j)) != 0 {
				continue
			}
			mask |= 1 << uint(j)
			stack = append(stack, reqs[j]...)
		}
		c.closure[i] = mask
	}
	c.closureCost = make([]int, n)
	c.closureTime = make([]int, n)
	for i := 0; i < n; i++ {
		m := c.closure[i]
		for m != 0 {
			j := bitsTrailing(m)
			m &= m - 1
			c.closureCost[i] += c.costs[j]
			c.closureTime[i] += c.times[j]
		}
	}

	// Requirement -> covering tests, sorted by (cost, time, index) so the
	// first available entry gives the cheapest admissible bound.
	c.coverersB = make([][]int, len(inst.Branches))
	c.coverersP = make([][]int, len(inst.Pairs))
	for i := 0; i < n; i++ {
		for j := 0; j < len(inst.Branches); j++ {
			if c.coverB[i].has(j) {
				c.coverersB[j] = append(c.coverersB[j], i)
			}
		}
		for j := 0; j < len(inst.Pairs); j++ {
			if c.coverP[i].has(j) {
				c.coverersP[j] = append(c.coverersP[j], i)
			}
		}
	}
	less := func(a, b int) bool {
		if c.costs[a] != c.costs[b] {
			return c.costs[a] < c.costs[b]
		}
		if c.times[a] != c.times[b] {
			return c.times[a] < c.times[b]
		}
		return a < b
	}
	for j := range c.coverersB {
		sort.Slice(c.coverersB[j], func(x, y int) bool { return less(c.coverersB[j][x], c.coverersB[j][y]) })
	}
	for j := range c.coverersP {
		sort.Slice(c.coverersP[j], func(x, y int) bool { return less(c.coverersP[j][x], c.coverersP[j][y]) })
	}

	// Branching order: most "efficient" tests first (coverage per cost),
	// which tends to find strong incumbents early.
	c.order = make([]int, n)
	for i := range c.order {
		c.order[i] = i
	}
	sort.SliceStable(c.order, func(x, y int) bool {
		a, b := c.order[x], c.order[y]
		ca := c.coverB[a].count() + c.coverP[a].count()
		cb := c.coverB[b].count() + c.coverP[b].count()
		// Compare ca/(cost[a]+1) > cb/(cost[b]+1) without floats.
		lhs := ca * (c.costs[b] + 1)
		rhs := cb * (c.costs[a] + 1)
		if lhs != rhs {
			return lhs > rhs
		}
		return a < b
	})
	return c, nil
}

func bitsTrailing(m uint64) int {
	// m != 0
	n := 0
	for m&1 == 0 {
		m >>= 1
		n++
	}
	return n
}
