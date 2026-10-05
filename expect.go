package markov

import (
	"fmt"
	"math/big"
	"strings"
)

// FiniteHorizon returns, for every start state, the exact expected
// cumulative reward collected over exactly the given number of steps.
// It iterates the Bellman recursion v_{k+1}(i) = R[i] + sum_j P[i][j] v_k(j)
// starting from v_0 = 0.
func (c *Chain) FiniteHorizon(steps int) []*big.Rat {
	n := c.Size()
	v := make([]*big.Rat, n)
	for i := range v {
		v[i] = new(big.Rat)
	}
	for s := 0; s < steps; s++ {
		next := make([]*big.Rat, n)
		for i := 0; i < n; i++ {
			acc := big.NewRat(c.R[i], 1)
			for j, p := range c.P[i] {
				if p.Sign() > 0 {
					acc.Add(acc, new(big.Rat).Mul(p, v[j]))
				}
			}
			next[i] = acc
		}
		v = next
	}
	return v
}

// FiniteHorizonUntilTarget returns, for every start state, the exact
// expected cumulative reward collected until the target set is hit, capped
// at the given number of steps (reward 0 on target states). As steps grows
// it converges to the HittingReward values on states that reach the target
// almost surely.
func (c *Chain) FiniteHorizonUntilTarget(steps int) []*big.Rat {
	n := c.Size()
	v := make([]*big.Rat, n)
	for i := range v {
		v[i] = new(big.Rat)
	}
	for s := 0; s < steps; s++ {
		next := make([]*big.Rat, n)
		for i := 0; i < n; i++ {
			if c.Target[i] {
				next[i] = new(big.Rat)
				continue
			}
			acc := big.NewRat(c.R[i], 1)
			for j, p := range c.P[i] {
				if p.Sign() > 0 {
					acc.Add(acc, new(big.Rat).Mul(p, v[j]))
				}
			}
			next[i] = acc
		}
		v = next
	}
	return v
}

// ClassKind distinguishes the long-run reward behavior of a closed class
// that contains no target state.
type ClassKind int

const (
	// ZeroReward means every state in the class has per-step reward 0, so
	// the cumulative reward stays constant once the class is entered.
	ZeroReward ClassKind = iota
	// Divergent means some state in the class has non-zero per-step
	// reward, so the cumulative reward over the (infinite) stay in the
	// class does not converge.
	Divergent
)

func (k ClassKind) String() string {
	if k == ZeroReward {
		return "zero-reward"
	}
	return "divergent"
}

// ClosedClass is a closed communicating class that contains no target
// state, together with human-readable evidence of its closure and its
// reward classification.
type ClosedClass struct {
	States   []int
	Kind     ClassKind
	Evidence string
}

// HittingResult is the outcome of a hitting-reward analysis.
type HittingResult struct {
	// Value[i] is the exact expected cumulative reward collected before
	// the target set is hit, starting from i. It is 0 on target states
	// and nil on states that do not reach the target almost surely.
	Value []*big.Rat
	// AlmostSure[i] reports whether the chain hits the target with
	// probability 1 from state i.
	AlmostSure []bool
	// Equations renders the first-step Bellman system that was solved.
	Equations string
	// ClosedClasses lists the closed non-target classes (the reason some
	// states fail to be almost-sure), each classified as divergent or
	// zero-reward.
	ClosedClasses []ClosedClass
}

// ClosedNonTargetClasses finds every closed communicating class that
// contains no target state and classifies its reward behavior.
func (c *Chain) ClosedNonTargetClasses() []ClosedClass {
	var out []ClosedClass
	for _, comp := range c.sccs() {
		in := make(map[int]bool, len(comp))
		hasTarget := false
		for _, s := range comp {
			in[s] = true
			if c.Target[s] {
				hasTarget = true
			}
		}
		if hasTarget {
			continue
		}
		closed := true
		for _, s := range comp {
			for _, j := range c.successors(s) {
				if !in[j] {
					closed = false
				}
			}
		}
		if !closed {
			continue
		}
		zero := true
		for _, s := range comp {
			if c.R[s] != 0 {
				zero = false
			}
		}
		kind := Divergent
		if zero {
			kind = ZeroReward
		}
		out = append(out, ClosedClass{
			States:   comp,
			Kind:     kind,
			Evidence: c.classEvidence(comp, kind),
		})
	}
	return out
}

// classEvidence renders proof that the class is closed and justifies its
// reward classification.
func (c *Chain) classEvidence(comp []int, kind ClassKind) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "class %v is closed:", comp)
	for _, s := range comp {
		var terms []string
		for _, j := range c.successors(s) {
			terms = append(terms, fmt.Sprintf("%d (p=%s)", j, c.P[s][j].RatString()))
		}
		fmt.Fprintf(&sb, " state %d -> {%s};", s, strings.Join(terms, ", "))
	}
	sb.WriteString(" all successors stay inside the class, so the class is never left.")
	rewards := make([]string, len(comp))
	for k, s := range comp {
		rewards[k] = fmt.Sprintf("R[%d]=%d", s, c.R[s])
	}
	if kind == ZeroReward {
		fmt.Fprintf(&sb, " Rewards %s are all zero: the cumulative reward stays constant forever once the class is entered.", strings.Join(rewards, ", "))
	} else {
		fmt.Fprintf(&sb, " Rewards %s are not all zero: the chain never leaves, so the cumulative reward does not converge (it diverges).", strings.Join(rewards, ", "))
	}
	return sb.String()
}

// HittingReward computes the exact expected cumulative reward collected
// before the target set is hit. For every state that hits the target
// almost surely it solves the first-step Bellman system
//
//	h_i = R[i] + sum_j P[i][j] h_j,   h = 0 on target states,
//
// i.e. (I - Q) h = r where Q is P restricted to almost-sure non-target
// states. States with a positive probability of being absorbed into a
// closed non-target class get a nil Value; those classes are reported in
// ClosedClasses with divergent / zero-reward classification.
func (c *Chain) HittingReward() *HittingResult {
	n := c.Size()
	res := &HittingResult{
		Value:         make([]*big.Rat, n),
		AlmostSure:    make([]bool, n),
		ClosedClasses: c.ClosedNonTargetClasses(),
	}
	inBadClass := make([]bool, n)
	for _, cc := range res.ClosedClasses {
		for _, s := range cc.States {
			inBadClass[s] = true
		}
	}
	// A state hits the target almost surely iff it cannot reach any
	// closed non-target class.
	canGoBad := c.reverseReach(inBadClass)
	var unknowns []int
	index := make(map[int]int)
	for i := 0; i < n; i++ {
		res.AlmostSure[i] = !canGoBad[i]
		if c.Target[i] {
			res.Value[i] = new(big.Rat)
			continue
		}
		if !canGoBad[i] {
			index[i] = len(unknowns)
			unknowns = append(unknowns, i)
		}
	}
	m := len(unknowns)
	res.Equations = c.renderEquations(unknowns)
	if m == 0 {
		return res
	}
	a := make([][]*big.Rat, m)
	b := make([]*big.Rat, m)
	for row, i := range unknowns {
		a[row] = make([]*big.Rat, m)
		for k := range a[row] {
			a[row][k] = new(big.Rat)
		}
		a[row][row].SetInt64(1)
		for j, p := range c.P[i] {
			if p.Sign() == 0 || c.Target[j] {
				continue
			}
			if k, ok := index[j]; ok {
				a[row][k].Sub(a[row][k], p)
			}
		}
		b[row] = big.NewRat(c.R[i], 1)
	}
	x, err := SolveRational(a, b)
	if err != nil {
		// (I - Q) is non-singular because Q is substochastic and
		// transient on the almost-sure set; reaching here would be a bug.
		panic(fmt.Sprintf("markov: solving hitting system: %v", err))
	}
	for k, i := range unknowns {
		res.Value[i] = x[k]
	}
	return res
}

// renderEquations renders the first-step Bellman equations for the
// unknown states.
func (c *Chain) renderEquations(unknowns []int) string {
	var sb strings.Builder
	sb.WriteString("first-step Bellman equations (h = 0 on target states), solved as (I - Q) h = r:\n")
	for _, i := range unknowns {
		fmt.Fprintf(&sb, "h_%d = %d", i, c.R[i])
		for j, p := range c.P[i] {
			if p.Sign() == 0 {
				continue
			}
			if c.Target[j] {
				fmt.Fprintf(&sb, " + %s*h_%d(=0, target)", p.RatString(), j)
			} else {
				fmt.Fprintf(&sb, " + %s*h_%d", p.RatString(), j)
			}
		}
		sb.WriteString("\n")
	}
	return sb.String()
}
