package automata

import (
	"reflect"
	"testing"
)

// literalNFA builds an NFA accepting exactly the string s, using one
// epsilon edge between the per-byte states to exercise epsilon support.
func literalNFA(s string) *NFA {
	n := NewNFA(len(s)+2, 0)
	for i := 0; i < len(s); i++ {
		n.AddTrans(i, s[i], i+1)
	}
	n.AddEps(len(s), len(s)+1)
	n.AddFinal(len(s) + 1)
	return n
}

func TestEpsilonClosure(t *testing.T) {
	n := NewNFA(4, 0)
	n.AddEps(0, 1)
	n.AddEps(1, 2)
	n.AddEps(2, 1) // cycle
	n.AddTrans(2, 'a', 3)
	if got := n.EpsilonClosure(0); !reflect.DeepEqual(got, []int{0, 1, 2}) {
		t.Fatalf("closure(0) = %v, want [0 1 2]", got)
	}
	if got := n.EpsilonClosure(3); !reflect.DeepEqual(got, []int{3}) {
		t.Fatalf("closure(3) = %v, want [3]", got)
	}
}

func TestAccepts(t *testing.T) {
	n := literalNFA("ab")
	for _, s := range []string{"ab"} {
		if !n.Accepts(s) {
			t.Fatalf("Accepts(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "a", "b", "aba", "abc", "ba"} {
		if n.Accepts(s) {
			t.Fatalf("Accepts(%q) = true, want false", s)
		}
	}
}

func TestAlphabetSorted(t *testing.T) {
	n := NewNFA(2, 0)
	n.AddTrans(0, 'b', 1)
	n.AddTrans(0, 'a', 1)
	n.AddTrans(0, 'a', 0)
	if got := n.Alphabet(); !reflect.DeepEqual(got, []byte{'a', 'b'}) {
		t.Fatalf("Alphabet() = %q, want \"ab\"", got)
	}
}
