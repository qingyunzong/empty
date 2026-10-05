package markov

import (
	"math/big"
	"strings"
	"testing"
)

func mustChain(t *testing.T, p [][]*big.Rat, r []int64, target []bool) *Chain {
	t.Helper()
	c, err := NewChain(p, r, target)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestFiniteHorizonHand(t *testing.T) {
	// P = [[1/2, 1/2], [0, 1]], R = [1, 2].
	c := mustChain(t,
		[][]*big.Rat{
			{big.NewRat(1, 2), big.NewRat(1, 2)},
			{big.NewRat(0, 1), big.NewRat(1, 1)},
		},
		[]int64{1, 2},
		[]bool{false, false},
	)
	ratsEq(t, c.FiniteHorizon(0), "0", "0")
	ratsEq(t, c.FiniteHorizon(1), "1", "2")
	// v2(0) = 1 + (1/2*1 + 1/2*2) = 5/2, v2(1) = 2 + 2 = 4
	ratsEq(t, c.FiniteHorizon(2), "5/2", "4")
	// v3(0) = 1 + (1/2*5/2 + 1/2*4) = 17/4, v3(1) = 6
	ratsEq(t, c.FiniteHorizon(3), "17/4", "6")
}

// enumeratePaths independently computes the expected cumulative reward
// over exactly `steps` steps by expanding the full probability tree of
// paths (no dynamic programming).
func enumeratePaths(c *Chain, start, steps int) *big.Rat {
	type node struct {
		prob  *big.Rat
		state int
	}
	frontier := []node{{big.NewRat(1, 1), start}}
	total := new(big.Rat)
	for s := 0; s < steps; s++ {
		var next []node
		for _, nd := range frontier {
			total.Add(total, new(big.Rat).Mul(nd.prob, big.NewRat(c.R[nd.state], 1)))
			for j, p := range c.P[nd.state] {
				if p.Sign() > 0 {
					next = append(next, node{new(big.Rat).Mul(nd.prob, p), j})
				}
			}
		}
		frontier = next
	}
	return total
}

// TestFiniteHorizonMatchesPathEnumeration is the short-step expansion
// cross-check: the DP recursion must agree with an explicit enumeration
// of every path up to length 5, from every start state.
func TestFiniteHorizonMatchesPathEnumeration(t *testing.T) {
	c := mustChain(t,
		[][]*big.Rat{
			{big.NewRat(1, 3), big.NewRat(2, 3), big.NewRat(0, 1)},
			{big.NewRat(1, 6), big.NewRat(1, 3), big.NewRat(1, 2)},
			{big.NewRat(0, 1), big.NewRat(1, 4), big.NewRat(3, 4)},
		},
		[]int64{2, -1, 3},
		[]bool{false, false, false},
	)
	for steps := 0; steps <= 5; steps++ {
		got := c.FiniteHorizon(steps)
		for start := 0; start < c.Size(); start++ {
			want := enumeratePaths(c, start, steps)
			if got[start].Cmp(want) != 0 {
				t.Errorf("steps=%d start=%d: DP=%s, path expansion=%s",
					steps, start, got[start].RatString(), want.RatString())
			}
		}
	}
}

// hittingChain returns a 4-state chain, state 3 target, all other states
// reaching it almost surely.
func hittingChain(t *testing.T) *Chain {
	t.Helper()
	return mustChain(t,
		[][]*big.Rat{
			{big.NewRat(0, 1), big.NewRat(2, 3), big.NewRat(1, 3), big.NewRat(0, 1)},
			{big.NewRat(1, 4), big.NewRat(0, 1), big.NewRat(0, 1), big.NewRat(3, 4)},
			{big.NewRat(1, 2), big.NewRat(0, 1), big.NewRat(0, 1), big.NewRat(1, 2)},
			{big.NewRat(0, 1), big.NewRat(0, 1), big.NewRat(0, 1), big.NewRat(1, 1)},
		},
		[]int64{1, -2, 4, 0},
		[]bool{false, false, false, true},
	)
}

func TestHittingRewardHand(t *testing.T) {
	// h0 = 1 + (1/2)h0 + (1/2)h1, h1 = 3 + (1/2)h0  =>  h0 = 10, h1 = 8.
	c := mustChain(t,
		[][]*big.Rat{
			{big.NewRat(1, 2), big.NewRat(1, 2), big.NewRat(0, 1)},
			{big.NewRat(1, 2), big.NewRat(0, 1), big.NewRat(1, 2)},
			{big.NewRat(0, 1), big.NewRat(0, 1), big.NewRat(1, 1)},
		},
		[]int64{1, 3, 0},
		[]bool{false, false, true},
	)
	res := c.HittingReward()
	ratsEq(t, res.Value, "10", "8", "0")
	for i, as := range res.AlmostSure {
		if !as {
			t.Errorf("state %d should reach the target almost surely", i)
		}
	}
	if len(res.ClosedClasses) != 0 {
		t.Errorf("unexpected closed non-target classes: %v", res.ClosedClasses)
	}
	if !strings.Contains(res.Equations, "h_0 = 1 + 1/2*h_0 + 1/2*h_1") {
		t.Errorf("equations missing h_0 line:\n%s", res.Equations)
	}
	if !strings.Contains(res.Equations, "h_1 = 3 + 1/2*h_0 + 1/2*h_2(=0, target)") {
		t.Errorf("equations missing h_1 line:\n%s", res.Equations)
	}
}

// TestHittingResidual verifies the solved values satisfy the first-step
// Bellman equations exactly: h_i = R[i] + sum_j P[i][j] h_j.
func TestHittingResidual(t *testing.T) {
	c := hittingChain(t)
	res := c.HittingReward()
	for i := 0; i < c.Size(); i++ {
		if res.Value[i] == nil {
			t.Fatalf("state %d: expected a defined hitting value", i)
		}
		lhs := res.Value[i]
		rhs := big.NewRat(c.R[i], 1)
		if c.Target[i] {
			rhs = new(big.Rat)
		} else {
			for j, p := range c.P[i] {
				if p.Sign() > 0 {
					rhs.Add(rhs, new(big.Rat).Mul(p, res.Value[j]))
				}
			}
		}
		if lhs.Cmp(rhs) != 0 {
			t.Errorf("state %d: h=%s but R+P*h=%s", i, lhs.RatString(), rhs.RatString())
		}
	}
}

// TestHittingBareissCrossCheck re-derives the (I - Q) h = r system,
// clears denominators, and solves it with the independent fraction-free
// Bareiss elimination; the solutions must agree exactly.
func TestHittingBareissCrossCheck(t *testing.T) {
	c := hittingChain(t)
	res := c.HittingReward()
	var unknowns []int
	index := map[int]int{}
	for i := 0; i < c.Size(); i++ {
		if !c.Target[i] && res.AlmostSure[i] {
			index[i] = len(unknowns)
			unknowns = append(unknowns, i)
		}
	}
	m := len(unknowns)
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
	ai, bi := clearDenominators(a, b)
	x, err := SolveBareiss(ai, bi)
	if err != nil {
		t.Fatal(err)
	}
	for k, i := range unknowns {
		if x[k].Cmp(res.Value[i]) != 0 {
			t.Errorf("state %d: gauss=%s bareiss=%s", i, res.Value[i].RatString(), x[k].RatString())
		}
	}
}

// TestTruncatedExpansionConverges checks the short-step expansion of the
// hitting problem: the truncated values FiniteHorizonUntilTarget(n) are
// monotone (non-negative rewards) and converge to the solved values.
func TestTruncatedExpansionConverges(t *testing.T) {
	c := mustChain(t,
		[][]*big.Rat{
			{big.NewRat(1, 2), big.NewRat(1, 2), big.NewRat(0, 1)},
			{big.NewRat(1, 2), big.NewRat(0, 1), big.NewRat(1, 2)},
			{big.NewRat(0, 1), big.NewRat(0, 1), big.NewRat(1, 1)},
		},
		[]int64{1, 3, 0},
		[]bool{false, false, true},
	)
	res := c.HittingReward()
	ratsEq(t, res.Value, "10", "8", "0")
	prev := c.FiniteHorizonUntilTarget(0)
	for n := 1; n <= 60; n++ {
		v := c.FiniteHorizonUntilTarget(n)
		for i := 0; i < c.Size(); i++ {
			if v[i].Cmp(prev[i]) < 0 {
				t.Fatalf("n=%d state %d: not monotone: %s < %s", n, i, v[i], prev[i])
			}
			if v[i].Cmp(res.Value[i]) > 0 {
				t.Fatalf("n=%d state %d: truncated value %s exceeds limit %s",
					n, i, v[i], res.Value[i])
			}
		}
		prev = v
	}
	eps := big.NewRat(1, 1000)
	for i := 0; i < c.Size(); i++ {
		diff := new(big.Rat).Sub(res.Value[i], prev[i])
		if diff.Cmp(eps) > 0 {
			t.Errorf("state %d: after 60 steps gap %s exceeds %s", i, diff, eps)
		}
	}
}

func TestClosedClassClassification(t *testing.T) {
	// 0 -> {1: 1/4, 2: 1/4, 3: 1/2}   R0 = 1
	// 1 -> {0: 1/2, 2: 1/2}           R1 = 2
	// 2 -> {2: 1} (target)            R2 = 0
	// 3 -> {3: 1/2, 4: 1/2}           R3 = 0   } closed zero-reward class
	// 4 -> {3: 1}                     R4 = 0   }
	// 5 -> {5: 1}                     R5 = 7   } closed divergent class
	// 6 -> {2: 1}                     R6 = 5
	z := big.NewRat(0, 1)
	c := mustChain(t,
		[][]*big.Rat{
			{z, big.NewRat(1, 4), big.NewRat(1, 4), big.NewRat(1, 2), z, z, z},
			{big.NewRat(1, 2), z, big.NewRat(1, 2), z, z, z, z},
			{z, z, big.NewRat(1, 1), z, z, z, z},
			{z, z, z, big.NewRat(1, 2), big.NewRat(1, 2), z, z},
			{z, z, z, big.NewRat(1, 1), z, z, z},
			{z, z, z, z, z, big.NewRat(1, 1), z},
			{z, z, big.NewRat(1, 1), z, z, z, z},
		},
		[]int64{1, 2, 0, 0, 0, 7, 5},
		[]bool{false, false, true, false, false, false, false},
	)
	res := c.HittingReward()
	if len(res.ClosedClasses) != 2 {
		t.Fatalf("got %d closed non-target classes, want 2", len(res.ClosedClasses))
	}
	byState := map[int]ClosedClass{}
	for _, cc := range res.ClosedClasses {
		for _, s := range cc.States {
			byState[s] = cc
		}
		if cc.Evidence == "" {
			t.Errorf("class %v: empty evidence", cc.States)
		}
	}
	zero, ok := byState[3]
	if !ok || zero.Kind != ZeroReward {
		t.Errorf("class of state 3: got %v, want zero-reward", zero.Kind)
	}
	if !strings.Contains(zero.Evidence, "class [3 4] is closed") ||
		!strings.Contains(zero.Evidence, "stays constant") {
		t.Errorf("zero-reward evidence unconvincing: %s", zero.Evidence)
	}
	div, ok := byState[5]
	if !ok || div.Kind != Divergent {
		t.Errorf("class of state 5: got %v, want divergent", div.Kind)
	}
	if !strings.Contains(div.Evidence, "diverges") {
		t.Errorf("divergent evidence unconvincing: %s", div.Evidence)
	}
	wantAS := []bool{false, false, true, false, false, false, true}
	for i, want := range wantAS {
		if res.AlmostSure[i] != want {
			t.Errorf("AlmostSure[%d] = %v, want %v", i, res.AlmostSure[i], want)
		}
	}
	for _, i := range []int{0, 1, 3, 4, 5} {
		if res.Value[i] != nil {
			t.Errorf("Value[%d] = %s, want nil (target not reached a.s.)", i, res.Value[i])
		}
	}
	ratsEq(t, []*big.Rat{res.Value[2], res.Value[6]}, "0", "5")
	if !strings.Contains(res.Equations, "h_6 = 5 + 1*h_2(=0, target)") {
		t.Errorf("equations missing h_6 line:\n%s", res.Equations)
	}
}
