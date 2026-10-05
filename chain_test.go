package markov

import (
	"math/big"
	"strings"
	"testing"
)

func TestNewChainValidation(t *testing.T) {
	one := big.NewRat(1, 1)
	if _, err := NewChain(nil, nil, nil); err == nil {
		t.Error("empty chain: expected error")
	}
	if _, err := NewChain([][]*big.Rat{{one}}, nil, []bool{false}); err == nil {
		t.Error("reward length mismatch: expected error")
	}
	if _, err := NewChain([][]*big.Rat{{one}}, []int64{0}, nil); err == nil {
		t.Error("target length mismatch: expected error")
	}
	if _, err := NewChain([][]*big.Rat{{big.NewRat(1, 2)}}, []int64{0}, []bool{false}); err == nil {
		t.Error("row not summing to 1: expected error")
	}
	if _, err := NewChain([][]*big.Rat{{big.NewRat(-1, 1), big.NewRat(2, 1)}}, []int64{0, 0}, []bool{false, false}); err == nil {
		t.Error("negative probability: expected error")
	}
	if _, err := NewChain([][]*big.Rat{{nil}}, []int64{0}, []bool{false}); err == nil {
		t.Error("nil probability: expected error")
	}
	if _, err := NewChain([][]*big.Rat{{one, one}}, []int64{0, 0}, []bool{false, false}); err == nil {
		t.Error("ragged row: expected error")
	}
	c, err := NewChain([][]*big.Rat{{one}}, []int64{3}, []bool{true})
	if err != nil {
		t.Fatalf("valid chain rejected: %v", err)
	}
	if c.Size() != 1 || c.R[0] != 3 || !c.Target[0] {
		t.Error("valid chain copied incorrectly")
	}
}

func TestSCCsAndClosure(t *testing.T) {
	// {0,1} transient, {2} target-absorbing, {3,4} closed, 5 transient into {3,4}.
	half := big.NewRat(1, 2)
	one := big.NewRat(1, 1)
	zero := big.NewRat(0, 1)
	p := [][]*big.Rat{
		{zero, half, half, zero, zero, zero},
		{half, zero, half, zero, zero, zero},
		{zero, zero, one, zero, zero, zero},
		{zero, zero, zero, half, half, zero},
		{zero, zero, zero, one, zero, zero},
		{zero, zero, zero, zero, one, zero},
	}
	c, err := NewChain(p, []int64{0, 0, 0, 0, 0, 0}, []bool{false, false, true, false, false, false})
	if err != nil {
		t.Fatal(err)
	}
	sccs := c.sccs()
	got := map[string]bool{}
	for _, comp := range sccs {
		var b strings.Builder
		for _, s := range comp {
			b.WriteByte(byte('0' + s))
		}
		got[b.String()] = true
	}
	for _, want := range []string{"01", "2", "34", "5"} {
		if !got[want] {
			t.Errorf("missing SCC %s in %v", want, sccs)
		}
	}
	classes := c.ClosedNonTargetClasses()
	if len(classes) != 1 {
		t.Fatalf("got %d closed non-target classes, want 1", len(classes))
	}
	if len(classes[0].States) != 2 || classes[0].States[0] != 3 || classes[0].States[1] != 4 {
		t.Errorf("closed class states = %v, want [3 4]", classes[0].States)
	}
}
