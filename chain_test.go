package markov

import (
	"math/big"
	"testing"
)

func TestNewChainValidates(t *testing.T) {
	names := []string{"A", "B"}
	reward := []int64{1, 0}
	cases := []struct {
		name string
		prob [][]string
	}{
		{"row sum not one", [][]string{{"1/2", "1/4"}, {"0", "1"}}},
		{"negative probability", [][]string{{"3/2", "-1/2"}, {"0", "1"}}},
		{"ragged row", [][]string{{"1"}, {"0", "1"}}},
		{"bad rational", [][]string{{"x", "1"}, {"0", "1"}}},
	}
	for _, tc := range cases {
		if _, err := NewChain(names, tc.prob, reward); err == nil {
			t.Errorf("%s: expected error, got nil", tc.name)
		}
	}
	if _, err := NewChain(names, [][]string{{"1/2", "1/2"}, {"0", "1"}}, []int64{1}); err == nil {
		t.Errorf("reward length mismatch: expected error, got nil")
	}
	if _, err := NewChain([]string{"A", "A"}, [][]string{{"1", "0"}, {"0", "1"}}, reward); err == nil {
		t.Errorf("duplicate names: expected error, got nil")
	}
}

func TestFiniteStepHandComputed(t *testing.T) {
	c := chainA(t)
	es := c.FiniteStepRewards(c.Index("A"), 3)
	want := []string{"0", "1", "5/2", "41/12"}
	for k, w := range want {
		if got := es[k]; got.RatString() != w {
			t.Errorf("E_%d = %s, want %s", k, got.RatString(), w)
		}
	}
}

func TestFiniteStepMatchesPathEnumeration(t *testing.T) {
	for _, build := range []func(*testing.T) *Chain{chainA, chainB, chainC, chainD} {
		c := build(t)
		for start := 0; start < c.NumStates(); start++ {
			for n := 0; n <= 5; n++ {
				iter := c.FiniteStepRewards(start, n)[n]
				enum := c.ExpandReward(start, n)
				if iter.Cmp(enum) != 0 {
					t.Errorf("start=%d n=%d: iteration %s != enumeration %s",
						start, n, iter, enum)
				}
			}
		}
	}
}

func TestFiniteStepConvergesToHittingSolution(t *testing.T) {
	c := chainA(t)
	res, err := c.ExpectedToTarget(c.Index("T"))
	if err != nil {
		t.Fatalf("ExpectedToTarget: %v", err)
	}
	got := c.FiniteStepRewards(c.Index("A"), 40)[40]
	diff := got.Sub(got, res[c.Index("A")].Value)
	diff.Abs(diff)
	tol, _ := new(big.Rat).SetString("1/100")
	if diff.Cmp(tol) >= 0 {
		t.Errorf("E_40 = %v, expected within 1/100 of %v", got, res[c.Index("A")].Value)
	}
}
