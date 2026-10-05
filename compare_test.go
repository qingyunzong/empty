package automata

import (
	"math/rand"
	"testing"
)

// unionNFA builds an NFA accepting exactly the given strings, sharing a
// start state via epsilon edges.
func unionNFA(words ...string) *NFA {
	total := 1
	for _, w := range words {
		total += len(w) + 1
	}
	n := NewNFA(total, 0)
	next := 1
	for _, w := range words {
		n.AddEps(0, next)
		for i := 0; i < len(w); i++ {
			n.AddTrans(next+i, w[i], next+i+1)
		}
		n.AddFinal(next + len(w))
		next += len(w) + 1
	}
	return n
}

func TestCompareEqual(t *testing.T) {
	a := literalNFA("ab")
	b := unionNFA("ab")
	res := Compare(a, b, 64)
	if res.Status != Equal {
		t.Fatalf("Status = %v, want equal (witness %q)", res.Status, res.Witness)
	}
	if !res.Cert.Complete {
		t.Fatal("certificate should be complete")
	}
	if err := res.Cert.Verify(a, b); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

func TestCompareEmptyWitness(t *testing.T) {
	a := NewNFA(1, 0)
	a.AddFinal(0) // accepts ""
	b := NewNFA(1, 0)
	res := Compare(a, b, 0) // difference visible before any expansion
	if res.Status != NotEqual || res.Witness != "" || !res.WitnessInA {
		t.Fatalf("got %v witness %q inA=%v, want not-equal \"\" inA=true",
			res.Status, res.Witness, res.WitnessInA)
	}
}

func TestCompareShortestBeatsLonger(t *testing.T) {
	// Differences: "aa" (len 2, only in a) and "b" (len 1, only in b).
	a := unionNFA("aa", "ab")
	b := unionNFA("ab", "b")
	res := Compare(a, b, 256)
	if res.Status != NotEqual || res.Witness != "b" || res.WitnessInA {
		t.Fatalf("got %v witness %q inA=%v, want not-equal \"b\" inA=false",
			res.Status, res.Witness, res.WitnessInA)
	}
}

func TestCompareLexicographicTieBreak(t *testing.T) {
	// Differences at length 2: "aa" (only in a) and "ac" (only in b).
	a := unionNFA("aa", "ab")
	b := unionNFA("ab", "ac")
	res := Compare(a, b, 256)
	if res.Status != NotEqual || res.Witness != "aa" || !res.WitnessInA {
		t.Fatalf("got %v witness %q inA=%v, want not-equal \"aa\" inA=true",
			res.Status, res.Witness, res.WitnessInA)
	}
	if err := res.Cert.Verify(a, b); err != nil {
		t.Fatalf("certificate does not verify: %v", err)
	}
}

// bigNFA recognizes (a|b)*a(a|b)^3; its subset construction has ~16 states.
func bigNFA() *NFA {
	n := NewNFA(5, 0)
	n.AddTrans(0, 'a', 0)
	n.AddTrans(0, 'b', 0)
	n.AddTrans(0, 'a', 1)
	n.AddTrans(1, 'a', 2)
	n.AddTrans(1, 'b', 2)
	n.AddTrans(2, 'a', 3)
	n.AddTrans(2, 'b', 3)
	n.AddTrans(3, 'a', 4)
	n.AddTrans(3, 'b', 4)
	n.AddFinal(4)
	return n
}

func TestCompareBudget(t *testing.T) {
	a, b := bigNFA(), bigNFA()

	res := Compare(a, b, 2)
	if res.Status != Unknown {
		t.Fatalf("Status = %v, want unknown with budget 2", res.Status)
	}
	if res.Cert.Complete {
		t.Fatal("certificate must be marked incomplete")
	}
	if res.Cert.Expanded != 2 {
		t.Fatalf("Expanded = %d, want 2", res.Cert.Expanded)
	}
	if err := res.Cert.Verify(a, b); err != nil {
		t.Fatalf("partial certificate does not verify: %v", err)
	}

	res = Compare(a, b, 1000)
	if res.Status != Equal {
		t.Fatalf("Status = %v, want equal with ample budget", res.Status)
	}
}

func TestCertificateTamper(t *testing.T) {
	a := literalNFA("ab")
	b := unionNFA("ab")
	res := Compare(a, b, 64)
	if res.Status != Equal {
		t.Fatalf("Status = %v, want equal", res.Status)
	}
	bad := *res.Cert
	bad.States = append([]CertState(nil), res.Cert.States...)
	bad.States[0].Edges = append([]CertEdge(nil), res.Cert.States[0].Edges...)
	bad.States[0].Edges[0].To = (bad.States[0].Edges[0].To + 1) % len(bad.States)
	if err := bad.Verify(a, b); err == nil {
		t.Fatal("tampered certificate verified successfully")
	}
}

func randomNFA(r *rand.Rand) *NFA {
	numStates := 1 + r.Intn(5)
	n := NewNFA(numStates, 0)
	for s := 0; s < numStates; s++ {
		if r.Float64() < 0.3 {
			n.AddFinal(s)
		}
		for _, c := range []byte{'a', 'b'} {
			for r.Float64() < 0.4 {
				n.AddTrans(s, c, r.Intn(numStates))
			}
		}
		if numStates > 1 && r.Float64() < 0.3 {
			n.AddEps(s, r.Intn(numStates))
		}
	}
	return n
}

func TestCrossCheckRandom(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	const maxLen = 7
	for i := 0; i < 300; i++ {
		a, b := randomNFA(r), randomNFA(r)
		res := Compare(a, b, 1<<20)
		switch res.Status {
		case Unknown:
			t.Fatalf("iter %d: unexpected unknown with huge budget", i)
		case Equal:
			if w, found := BruteForceDifference(a, b, maxLen); found {
				t.Fatalf("iter %d: equal but brute force found %q", i, w)
			}
		case NotEqual:
			if a.Accepts(res.Witness) == b.Accepts(res.Witness) {
				t.Fatalf("iter %d: witness %q does not distinguish", i, res.Witness)
			}
			if res.WitnessInA != a.Accepts(res.Witness) {
				t.Fatalf("iter %d: WitnessInA wrong for %q", i, res.Witness)
			}
			if len(res.Witness) <= maxLen {
				w, found := BruteForceDifference(a, b, maxLen)
				if !found || w != res.Witness {
					t.Fatalf("iter %d: witness %q, brute force says %q (found=%v)",
						i, res.Witness, w, found)
				}
			}
		}
		if err := res.Cert.Verify(a, b); err != nil {
			t.Fatalf("iter %d: certificate does not verify: %v", i, err)
		}
	}
}
