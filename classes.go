package markov

import (
	"fmt"
	"math/big"
	"sort"
)

// ClassKind classifies a strongly connected component by its long-run
// reward behaviour.
type ClassKind int

const (
	// TransientClass is a strongly connected component with an exit edge.
	TransientClass ClassKind = iota
	// ClosedZeroReward is a closed class whose stationary mean reward is
	// zero: the cumulative reward inside it stays bounded.
	ClosedZeroReward
	// ClosedDivergent is a closed class whose stationary mean reward is
	// nonzero: the cumulative reward inside it diverges linearly.
	ClosedDivergent
)

func (k ClassKind) String() string {
	switch k {
	case TransientClass:
		return "瞬态类"
	case ClosedZeroReward:
		return "零收益闭类"
	case ClosedDivergent:
		return "发散闭类"
	}
	return "?"
}

// Class is a strongly connected component of the transition graph.
// Stationary, MeanReward and Potential are set only for closed classes;
// Potential only for closed zero-mean classes.
type Class struct {
	States     []int      // member state indices, ascending
	Closed     bool       // no transition leaves the class
	Kind       ClassKind  // reward classification
	Stationary []*big.Rat // stationary distribution over States
	MeanReward *big.Rat   // stationary mean reward mu = sum pi_i R_i
	Potential  []*big.Rat // Poisson potential h per member (zero-mean only)
}

// Classes returns the strongly connected components of the transition
// graph, ordered by their smallest state index. Closed classes carry
// their stationary distribution, mean reward and (when the mean is zero)
// the Poisson potential used as entry boundary values.
func (c *Chain) Classes() []*Class {
	comps := c.sccs()
	sort.Slice(comps, func(a, b int) bool { return comps[a][0] < comps[b][0] })
	var out []*Class
	for _, comp := range comps {
		cl := &Class{States: comp, Kind: TransientClass}
		inClass := make([]bool, c.NumStates())
		for _, s := range comp {
			inClass[s] = true
		}
		closed := true
		for _, s := range comp {
			for j, p := range c.P[s] {
				if p.Sign() != 0 && !inClass[j] {
					closed = false
				}
			}
		}
		cl.Closed = closed
		if closed {
			if pi, err := c.stationary(comp); err == nil {
				cl.Stationary = pi
				mu := new(big.Rat)
				for k, s := range comp {
					mu.Add(mu, new(big.Rat).Mul(pi[k], ratOfInt(c.R[s])))
				}
				cl.MeanReward = mu
				if mu.Sign() != 0 {
					cl.Kind = ClosedDivergent
				} else {
					cl.Kind = ClosedZeroReward
					cl.Potential, _ = c.poissonPotential(comp, pi)
				}
			}
		}
		out = append(out, cl)
	}
	return out
}

// classEvidence renders, for every member state, the exact in-class
// transition mass and any exit edges: direct proof of (non-)closedness.
func (c *Chain) classEvidence(cl *Class) []string {
	inClass := make([]bool, c.NumStates())
	for _, s := range cl.States {
		inClass[s] = true
	}
	var lines []string
	for _, s := range cl.States {
		sum := new(big.Rat)
		var exits []string
		for j, p := range c.P[s] {
			if p.Sign() == 0 {
				continue
			}
			if inClass[j] {
				sum.Add(sum, p)
			} else {
				exits = append(exits, c.Names[j])
			}
		}
		if len(exits) == 0 {
			lines = append(lines, fmt.Sprintf("%s: 类内转移概率和 = %s, 无离类边",
				c.Names[s], sum.RatString()))
		} else {
			lines = append(lines, fmt.Sprintf("%s: 类内转移概率和 = %s, 离类边 → %v",
				c.Names[s], sum.RatString(), exits))
		}
	}
	return lines
}

// stationary solves pi (P_C - I) = 0 with sum(pi) = 1 for the closed
// class comp, replacing the last equation by the normalization.
func (c *Chain) stationary(comp []int) ([]*big.Rat, error) {
	k := len(comp)
	a := make([][]*big.Rat, k)
	b := make([]*big.Rat, k)
	for i := 0; i < k; i++ {
		row := make([]*big.Rat, k)
		for j := 0; j < k; j++ {
			row[j] = new(big.Rat)
		}
		b[i] = new(big.Rat)
		a[i] = row
	}
	for i := 0; i < k-1; i++ {
		for j := 0; j < k; j++ {
			a[i][j].Set(c.P[comp[j]][comp[i]]) // (P^T)_{ij}
		}
		a[i][i].Sub(a[i][i], ratInt(1))
	}
	for j := 0; j < k; j++ {
		a[k-1][j].SetInt64(1)
	}
	b[k-1].SetInt64(1)
	return SolveGauss(a, b)
}

// poissonPotential solves (I - P_C) h = R_C with pi.h = 0 for a closed
// zero-mean class. h(s) is the (Cesaro) limit of the expected cumulative
// reward E_s[sum_{k<n} R(X_k)]; the limit is strict when the class is
// aperiodic. It serves as the boundary value when the chain enters the
// class at state s.
func (c *Chain) poissonPotential(comp []int, pi []*big.Rat) ([]*big.Rat, error) {
	k := len(comp)
	a := make([][]*big.Rat, k)
	b := make([]*big.Rat, k)
	for i := 0; i < k; i++ {
		row := make([]*big.Rat, k)
		for j := 0; j < k; j++ {
			row[j] = new(big.Rat)
		}
		a[i] = row
		b[i] = ratOfInt(c.R[comp[i]])
	}
	for i := 0; i < k-1; i++ {
		for j := 0; j < k; j++ {
			a[i][j].Set(c.P[comp[i]][comp[j]])
			a[i][j].Neg(a[i][j])
		}
		a[i][i].Add(a[i][i], ratInt(1))
	}
	for j := 0; j < k; j++ {
		a[k-1][j].Set(pi[j])
	}
	b[k-1].SetInt64(0)
	return SolveGauss(a, b)
}

// sccs finds strongly connected components with Tarjan's algorithm over
// the support graph of P.
func (c *Chain) sccs() [][]int {
	n := c.NumStates()
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	for i := range index {
		index[i] = -1
	}
	var stack []int
	var out [][]int
	counter := 0
	var connect func(v int)
	connect = func(v int) {
		index[v] = counter
		low[v] = counter
		counter++
		stack = append(stack, v)
		onStack[v] = true
		for w, p := range c.P[v] {
			if p.Sign() == 0 {
				continue
			}
			if index[w] == -1 {
				connect(w)
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
			connect(v)
		}
	}
	return out
}
