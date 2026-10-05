// Package markov analyzes finite Markov chains with rational transition
// probabilities and integer per-step rewards, using exact arithmetic only
// (math/big); no floating point is involved anywhere.
//
// The library answers three questions:
//
//  1. Finite-horizon expectation E[sum_{k=0}^{n-1} R(X_k)].
//  2. Expected cumulative reward until a set of target states is hit.
//  3. Classification of closed classes that never reach the target:
//     divergent (nonzero stationary mean reward) vs zero-reward.
//
// Results are cross-checked by two independent exact linear solvers
// (Gaussian elimination over big.Rat and the fraction-free Bareiss
// algorithm over big.Int) and by brute-force short-step path expansion.
package markov

import (
	"fmt"
	"math/big"
)

// Chain is a finite Markov chain with rational transition probabilities
// P[i][j] = Pr(X_{n+1}=j | X_n=i) and integer per-state rewards R[i]
// (the reward collected for each step spent in state i).
type Chain struct {
	Names []string
	P     [][]*big.Rat
	R     []*big.Int
}

// NewChain builds a Chain from state names, transition probabilities given
// as rational strings ("1/2", "3", "2/7", ...) and integer rewards.
// Every row of the transition matrix must be nonnegative and sum to 1.
func NewChain(names []string, prob [][]string, reward []int64) (*Chain, error) {
	n := len(names)
	if n == 0 {
		return nil, fmt.Errorf("chain needs at least one state")
	}
	if len(prob) != n || len(reward) != n {
		return nil, fmt.Errorf("need %d transition rows and %d rewards, got %d and %d",
			n, n, len(prob), len(reward))
	}
	seen := make(map[string]bool, n)
	for _, nm := range names {
		if seen[nm] {
			return nil, fmt.Errorf("duplicate state name %q", nm)
		}
		seen[nm] = true
	}
	c := &Chain{
		Names: append([]string(nil), names...),
		P:     make([][]*big.Rat, n),
		R:     make([]*big.Int, n),
	}
	one := big.NewRat(1, 1)
	for i := range prob {
		if len(prob[i]) != n {
			return nil, fmt.Errorf("row %d (%s): need %d entries, got %d",
				i, names[i], n, len(prob[i]))
		}
		row := make([]*big.Rat, n)
		sum := new(big.Rat)
		for j, s := range prob[i] {
			v, ok := new(big.Rat).SetString(s)
			if !ok {
				return nil, fmt.Errorf("P[%d][%d]: bad rational %q", i, j, s)
			}
			if v.Sign() < 0 {
				return nil, fmt.Errorf("P[%d][%d]: negative probability %s", i, j, v)
			}
			row[j] = v
			sum.Add(sum, v)
		}
		if sum.Cmp(one) != 0 {
			return nil, fmt.Errorf("row %d (%s): probabilities sum to %s, not 1",
				i, names[i], sum)
		}
		c.P[i] = row
		c.R[i] = big.NewInt(reward[i])
	}
	return c, nil
}

// NumStates returns the number of states.
func (c *Chain) NumStates() int { return len(c.Names) }

// Index returns the index of the named state, or -1.
func (c *Chain) Index(name string) int {
	for i, nm := range c.Names {
		if nm == name {
			return i
		}
	}
	return -1
}

func ratInt(v int64) *big.Rat { return big.NewRat(v, 1) }

func ratOfInt(v *big.Int) *big.Rat { return new(big.Rat).SetInt(v) }
