// Package markov analyzes finite Markov chains with rational transition
// probabilities and integer per-step rewards. It computes exact
// finite-horizon expected cumulative rewards, expected cumulative reward
// until a target set is hit (via first-step Bellman equations solved with
// exact rational arithmetic), and classifies closed non-target classes as
// reward-divergent or zero-reward.
package markov

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// Chain is a finite Markov chain with rational transitions and integer
// per-step rewards. P[i][j] is the probability of moving from state i to
// state j, R[i] is the reward collected on each visit to state i, and
// Target[i] marks i as a goal (accumulation stops there).
type Chain struct {
	P      [][]*big.Rat
	R      []int64
	Target []bool
}

// NewChain validates and copies the given transition matrix, rewards, and
// target mask. Every row of p must be non-negative and sum to exactly 1.
func NewChain(p [][]*big.Rat, r []int64, target []bool) (*Chain, error) {
	n := len(p)
	if n == 0 {
		return nil, errors.New("markov: chain must have at least one state")
	}
	if len(r) != n {
		return nil, fmt.Errorf("markov: got %d rewards for %d states", len(r), n)
	}
	if len(target) != n {
		return nil, fmt.Errorf("markov: got %d target flags for %d states", len(target), n)
	}
	one := big.NewRat(1, 1)
	cp := make([][]*big.Rat, n)
	for i := range p {
		if len(p[i]) != n {
			return nil, fmt.Errorf("markov: row %d has %d entries, want %d", i, len(p[i]), n)
		}
		cp[i] = make([]*big.Rat, n)
		sum := new(big.Rat)
		for j := range p[i] {
			if p[i][j] == nil {
				return nil, fmt.Errorf("markov: nil probability at P[%d][%d]", i, j)
			}
			if p[i][j].Sign() < 0 {
				return nil, fmt.Errorf("markov: negative probability %s at P[%d][%d]", p[i][j].RatString(), i, j)
			}
			sum.Add(sum, p[i][j])
			cp[i][j] = new(big.Rat).Set(p[i][j])
		}
		if sum.Cmp(one) != 0 {
			return nil, fmt.Errorf("markov: row %d sums to %s, want 1", i, sum.RatString())
		}
	}
	cr := make([]int64, n)
	copy(cr, r)
	ct := make([]bool, n)
	copy(ct, target)
	return &Chain{P: cp, R: cr, Target: ct}, nil
}

// Size returns the number of states.
func (c *Chain) Size() int { return len(c.P) }

// successors lists the states reachable from i in one step.
func (c *Chain) successors(i int) []int {
	var out []int
	for j, p := range c.P[i] {
		if p.Sign() > 0 {
			out = append(out, j)
		}
	}
	return out
}

// sccs returns the strongly connected components of the transition graph
// (Tarjan's algorithm), each sorted ascending.
func (c *Chain) sccs() [][]int {
	n := c.Size()
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	for i := range index {
		index[i] = -1
	}
	var stack []int
	counter := 0
	var out [][]int
	var strongconnect func(v int)
	strongconnect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for _, w := range c.successors(v) {
			if index[w] == -1 {
				strongconnect(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] && index[w] < low[v] {
				low[v] = index[w]
			}
		}
		if low[v] == index[v] {
			var comp []int
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				comp = append(comp, w)
				if w == v {
					break
				}
			}
			sort.Ints(comp)
			out = append(out, comp)
		}
	}
	for v := 0; v < n; v++ {
		if index[v] == -1 {
			strongconnect(v)
		}
	}
	return out
}

// reverseReach returns the set of states that can reach any seed state
// along positive-probability edges (seeds included).
func (c *Chain) reverseReach(seed []bool) []bool {
	n := c.Size()
	pred := make([][]int, n)
	for i := 0; i < n; i++ {
		for _, j := range c.successors(i) {
			pred[j] = append(pred[j], i)
		}
	}
	reach := make([]bool, n)
	var queue []int
	for i := 0; i < n; i++ {
		if seed[i] {
			reach[i] = true
			queue = append(queue, i)
		}
	}
	for len(queue) > 0 {
		j := queue[0]
		queue = queue[1:]
		for _, i := range pred[j] {
			if !reach[i] {
				reach[i] = true
				queue = append(queue, i)
			}
		}
	}
	return reach
}
