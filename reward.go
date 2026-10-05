package markov

import (
	"fmt"
	"math/big"
)

// FiniteStepRewards returns E_n = E[sum_{k=0}^{n-1} R(X_k)] for
// n = 0..steps, starting from state start, computed by exact iteration
// of the distribution row vector.
func (c *Chain) FiniteStepRewards(start, steps int) []*big.Rat {
	n := c.NumStates()
	out := make([]*big.Rat, steps+1)
	dist := make([]*big.Rat, n)
	for i := range dist {
		dist[i] = new(big.Rat)
	}
	dist[start] = ratInt(1)
	out[0] = new(big.Rat)
	acc := new(big.Rat)
	for k := 0; k < steps; k++ {
		for i := 0; i < n; i++ {
			if dist[i].Sign() == 0 {
				continue
			}
			acc.Add(acc, new(big.Rat).Mul(dist[i], ratOfInt(c.R[i])))
		}
		out[k+1] = new(big.Rat).Set(acc)
		next := make([]*big.Rat, n)
		for j := range next {
			next[j] = new(big.Rat)
		}
		for i := 0; i < n; i++ {
			if dist[i].Sign() == 0 {
				continue
			}
			for j := 0; j < n; j++ {
				if c.P[i][j].Sign() == 0 {
					continue
				}
				next[j].Add(next[j], new(big.Rat).Mul(dist[i], c.P[i][j]))
			}
		}
		dist = next
	}
	return out
}

// ExpandReward computes the same finite-step expectation
// E[sum_{k=0}^{steps-1} R(X_k)] by explicit enumeration of all paths,
// without any aggregation by state. It is exponentially expensive and
// meant as an independent short-step cross-check of FiniteStepRewards.
func (c *Chain) ExpandReward(start, steps int) *big.Rat {
	total := new(big.Rat)
	var walk func(state, k int, prob *big.Rat)
	walk = func(state, k int, prob *big.Rat) {
		if k == steps {
			return
		}
		total.Add(total, new(big.Rat).Mul(prob, ratOfInt(c.R[state])))
		for j, p := range c.P[state] {
			if p.Sign() == 0 {
				continue
			}
			walk(j, k+1, new(big.Rat).Mul(prob, p))
		}
	}
	walk(start, 0, ratInt(1))
	return total
}

// HitStatus describes the behaviour of the cumulative reward before the
// target set is hit.
type HitStatus int

const (
	// Finite means the expected cumulative reward is a finite rational.
	Finite HitStatus = iota
	// DivergesPlus means a closed class with positive mean reward is
	// reachable with positive probability: expectation is +infinity.
	DivergesPlus
	// DivergesMinus means a closed class with negative mean reward is
	// reachable with positive probability: expectation is -infinity.
	DivergesMinus
	// Undefined means divergent classes of both signs are reachable.
	Undefined
)

func (s HitStatus) String() string {
	switch s {
	case Finite:
		return "有限"
	case DivergesPlus:
		return "+∞（发散）"
	case DivergesMinus:
		return "-∞（发散）"
	case Undefined:
		return "未定（±∞ 混合）"
	}
	return "?"
}

// HitResult is the per-state answer for the reward-before-target problem.
type HitResult struct {
	Status HitStatus
	Value  *big.Rat // non-nil iff Status == Finite
}

// hitAnalysis is the internal result of the hitting-reward analysis.
type hitAnalysis struct {
	results  []*HitResult // per state
	vars     []int        // states appearing in the linear system
	a        [][]*big.Rat // I - Q restricted to vars
	b        []*big.Rat   // rewards + closed-class boundary contributions
	boundary []*big.Rat   // the boundary part of b (per var row)
	solution []*big.Rat   // Gauss solution over vars
}

// ExpectedToTarget computes, for every state, the expected cumulative
// reward E[sum_{k=0}^{tau-1} R(X_k)] where tau is the hitting time of the
// target set (tau = infinity if the target is never hit). States that can
// reach a divergent closed class report DivergesPlus/DivergesMinus/
// Undefined; states absorbed into zero-reward closed classes get the
// class's Poisson potential as their finite value.
func (c *Chain) ExpectedToTarget(targets ...int) ([]*HitResult, error) {
	ha, err := c.analyzeHit(targets)
	if err != nil {
		return nil, err
	}
	return ha.results, nil
}

func (c *Chain) analyzeHit(targets []int) (*hitAnalysis, error) {
	n := c.NumStates()
	inTarget := make([]bool, n)
	for _, t := range targets {
		if t < 0 || t >= n {
			return nil, fmt.Errorf("target index %d out of range [0,%d)", t, n)
		}
		inTarget[t] = true
	}
	ha := &hitAnalysis{results: make([]*HitResult, n)}
	for i := 0; i < n; i++ {
		if inTarget[i] {
			ha.results[i] = &HitResult{Status: Finite, Value: new(big.Rat)}
		}
	}
	// Closed classes disjoint from the target set drive the asymptotics.
	zeroH := map[int]*big.Rat{} // zero-mean class state -> Poisson potential
	divSign := map[int]int{}    // divergent class state -> sign of mu
	for _, cl := range c.Classes() {
		if !cl.Closed {
			continue
		}
		hasTarget := false
		for _, s := range cl.States {
			if inTarget[s] {
				hasTarget = true
				break
			}
		}
		if hasTarget {
			continue
		}
		if cl.Kind == ClosedDivergent {
			for _, s := range cl.States {
				divSign[s] = cl.MeanReward.Sign()
			}
		} else {
			for k, s := range cl.States {
				zeroH[s] = cl.Potential[k]
			}
		}
	}
	// States that can reach a divergent class diverge with its sign.
	for i := 0; i < n; i++ {
		if ha.results[i] != nil {
			continue
		}
		reach := c.reachableFrom(i)
		plus, minus := false, false
		for s, sg := range divSign {
			if !reach[s] {
				continue
			}
			if sg > 0 {
				plus = true
			} else {
				minus = true
			}
		}
		switch {
		case plus && minus:
			ha.results[i] = &HitResult{Status: Undefined}
		case plus:
			ha.results[i] = &HitResult{Status: DivergesPlus}
		case minus:
			ha.results[i] = &HitResult{Status: DivergesMinus}
		}
	}
	// Members of zero-mean closed classes: finite, equal to the potential.
	for i := 0; i < n; i++ {
		if ha.results[i] != nil {
			continue
		}
		if h, ok := zeroH[i]; ok {
			ha.results[i] = &HitResult{Status: Finite, Value: new(big.Rat).Set(h)}
		}
	}
	// Remaining states form a nonsingular system (I - Q) x = b: every
	// closed class reachable from them is either the target boundary or a
	// zero-mean class folded into the constant term.
	var vars []int
	for i := 0; i < n; i++ {
		if ha.results[i] == nil {
			vars = append(vars, i)
		}
	}
	ha.vars = vars
	m := len(vars)
	col := make(map[int]int, m)
	for k, v := range vars {
		col[v] = k
	}
	ha.a = make([][]*big.Rat, m)
	ha.b = make([]*big.Rat, m)
	ha.boundary = make([]*big.Rat, m)
	for row, i := range vars {
		a := make([]*big.Rat, m)
		for k := range a {
			a[k] = new(big.Rat)
		}
		for j, p := range c.P[i] {
			if p.Sign() == 0 {
				continue
			}
			if k, ok := col[j]; ok {
				a[k].Sub(a[k], p)
			}
		}
		a[row].Add(a[row], ratInt(1))
		boundary := new(big.Rat)
		for j, p := range c.P[i] {
			if p.Sign() == 0 {
				continue
			}
			if h, ok := zeroH[j]; ok {
				boundary.Add(boundary, new(big.Rat).Mul(p, h))
			}
		}
		b := ratOfInt(c.R[i])
		b.Add(b, boundary)
		ha.a[row] = a
		ha.b[row] = b
		ha.boundary[row] = boundary
	}
	if m > 0 {
		sol, err := SolveGauss(ha.a, ha.b)
		if err != nil {
			return nil, fmt.Errorf("hitting system: %w", err)
		}
		ha.solution = sol
		for k, i := range vars {
			ha.results[i] = &HitResult{Status: Finite, Value: sol[k]}
		}
	}
	return ha, nil
}

// reachableFrom returns the set of states reachable from start through
// positive-probability transitions (start included).
func (c *Chain) reachableFrom(start int) []bool {
	n := c.NumStates()
	seen := make([]bool, n)
	stack := []int{start}
	seen[start] = true
	for len(stack) > 0 {
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for w, p := range c.P[v] {
			if p.Sign() != 0 && !seen[w] {
				seen[w] = true
				stack = append(stack, w)
			}
		}
	}
	return seen
}

// Verification bundles the independent exact cross-checks.
type Verification struct {
	Residual  *big.Rat // max |A x - b| over the hitting system (exactly 0)
	BareissOK bool     // Bareiss and Gauss solutions agree exactly
	ShortN    int      // horizon used for the short-step expansion check
	ShortIter *big.Rat // FiniteStepRewards value at ShortN
	ShortEnum *big.Rat // ExpandReward value at ShortN
	ShortOK   bool     // the two agree exactly
}

// Verify re-solves the hitting system with the independent Bareiss
// elimination, computes the exact residual of the Gauss solution, and
// compares the finite-step expectation at horizon shortN between matrix
// iteration and brute-force path enumeration.
func (c *Chain) Verify(start int, targets []int, shortN int) (*Verification, error) {
	ha, err := c.analyzeHit(targets)
	if err != nil {
		return nil, err
	}
	return c.verifyHit(ha, start, shortN)
}

func (c *Chain) verifyHit(ha *hitAnalysis, start, shortN int) (*Verification, error) {
	v := &Verification{Residual: new(big.Rat), BareissOK: true}
	if len(ha.vars) > 0 {
		xb, err := SolveBareiss(ha.a, ha.b)
		if err != nil {
			return nil, fmt.Errorf("verify: %w", err)
		}
		for k := range ha.vars {
			if xb[k].Cmp(ha.solution[k]) != 0 {
				v.BareissOK = false
			}
			row := new(big.Rat)
			for j := range ha.vars {
				row.Add(row, new(big.Rat).Mul(ha.a[k][j], ha.solution[j]))
			}
			row.Sub(row, ha.b[k])
			row.Abs(row)
			if row.Cmp(v.Residual) > 0 {
				v.Residual.Set(row)
			}
		}
	}
	v.ShortN = shortN
	v.ShortIter = c.FiniteStepRewards(start, shortN)[shortN]
	v.ShortEnum = c.ExpandReward(start, shortN)
	v.ShortOK = v.ShortIter.Cmp(v.ShortEnum) == 0
	return v, nil
}
