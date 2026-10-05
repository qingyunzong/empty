package markov

import (
	"math/big"
	"testing"
)

func mustChain(t *testing.T, names []string, prob [][]string, reward []int64) *Chain {
	t.Helper()
	c, err := NewChain(names, prob, reward)
	if err != nil {
		t.Fatalf("NewChain: %v", err)
	}
	return c
}

func ratEq(t *testing.T, got *big.Rat, want string) {
	t.Helper()
	w, ok := new(big.Rat).SetString(want)
	if !ok {
		t.Fatalf("bad want value %q", want)
	}
	if got == nil || got.Cmp(w) != 0 {
		t.Errorf("got %v, want %s", got, w)
	}
}

// chainA is an absorbing chain with target T and hand-computable answers:
//
//	A: 1/2 A, 1/2 B,  reward 1
//	B: 1/3 A, 2/3 T,  reward 2
//	T: 1 T,           reward 0
//
// x(A) = 6, x(B) = 4; E_1 = 1, E_2 = 5/2, E_3 = 41/12 from A.
func chainA(t *testing.T) *Chain {
	t.Helper()
	return mustChain(t,
		[]string{"A", "B", "T"},
		[][]string{
			{"1/2", "1/2", "0"},
			{"1/3", "0", "2/3"},
			{"0", "0", "1"},
		},
		[]int64{1, 2, 0},
	)
}

// chainB has a transient state S, a zero-reward closed class {Z}, a
// divergent closed class {D1,D2} with mean reward 3/2, and target T.
func chainB(t *testing.T) *Chain {
	t.Helper()
	return mustChain(t,
		[]string{"S", "Z", "D1", "D2", "T"},
		[][]string{
			{"1/2", "1/4", "1/8", "0", "1/8"},
			{"0", "1", "0", "0", "0"},
			{"0", "0", "0", "1", "0"},
			{"0", "0", "1", "0", "0"},
			{"0", "0", "0", "0", "1"},
		},
		[]int64{1, 0, 1, 2, 0},
	)
}

// chainC reaches a zero-reward closed class with probability 1/2, so the
// target is not hit almost surely, yet the cumulative reward is finite:
// x(S) = 2 + (1/2) x(S) = 4.
func chainC(t *testing.T) *Chain {
	t.Helper()
	return mustChain(t,
		[]string{"S", "Z", "T"},
		[][]string{
			{"1/2", "1/4", "1/4"},
			{"0", "1", "0"},
			{"0", "0", "1"},
		},
		[]int64{2, 0, 0},
	)
}

// chainD has an aperiodic zero-mean closed class {U,V} (rewards +1, -2,
// stationary 2/3, 1/3, mean 0) with Poisson potential h(U)=2/3, h(V)=-4/3.
// From S the chain enters U with probability 1/2, so x(S) = 1/3.
func chainD(t *testing.T) *Chain {
	t.Helper()
	return mustChain(t,
		[]string{"S", "U", "V", "T"},
		[][]string{
			{"0", "1/2", "0", "1/2"},
			{"0", "1/2", "1/2", "0"},
			{"0", "1", "0", "0"},
			{"0", "0", "0", "1"},
		},
		[]int64{0, 1, -2, 0},
	)
}
