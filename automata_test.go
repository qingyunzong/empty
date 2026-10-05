package automata

import "testing"

// allAB accepts (a|b)* with a single state.
func allAB() *NFA {
	n := New(1, 0)
	n.Accept[0] = true
	n.AddEdge(0, 'a', 0)
	n.AddEdge(0, 'b', 0)
	return n
}

// allABThompson accepts (a|b)* via Thompson-style construction with
// epsilon edges.
func allABThompson() *NFA {
	n := New(6, 0)
	n.Accept[5] = true
	n.AddEpsilon(0, 1)
	n.AddEpsilon(0, 5)
	n.AddEdge(1, 'a', 2)
	n.AddEdge(1, 'b', 3)
	n.AddEpsilon(2, 4)
	n.AddEpsilon(3, 4)
	n.AddEpsilon(4, 1)
	n.AddEpsilon(4, 5)
	return n
}

// endsWith accepts strings over {a,b} ending with the given byte.
func endsWith(c byte) *NFA {
	n := New(2, 0)
	n.Accept[1] = true
	n.AddEdge(0, 'a', 0)
	n.AddEdge(0, 'b', 0)
	n.AddEdge(0, c, 1)
	return n
}

// exactly accepts exactly the given string.
func exactly(s string) *NFA {
	n := New(len(s)+1, 0)
	n.Accept[len(s)] = true
	for i := 0; i < len(s); i++ {
		n.AddEdge(i, s[i], i+1)
	}
	return n
}

func TestEvalEpsilon(t *testing.T) {
	n := allABThompson()
	for _, s := range []string{"", "a", "b", "ab", "ba", "abba", "bbbb"} {
		if !n.Eval(s) {
			t.Fatalf("expected %q accepted", s)
		}
	}
	if n.Eval("abc") {
		t.Fatal("expected \"abc\" rejected")
	}
}

func TestEquivalentWithEpsilon(t *testing.T) {
	r := Compare(allAB(), allABThompson(), 10000)
	if r.Verdict != Equivalent {
		t.Fatalf("verdict = %v, want equivalent (witness %q)", r.Verdict, r.Witness)
	}
	if _, found := FindDiffBrute(allAB(), allABThompson(), 6); found {
		t.Fatal("brute force found a difference within length 6")
	}
}

func TestDifferentShortestWitness(t *testing.T) {
	a, b := endsWith('a'), endsWith('b')
	r := Compare(a, b, 10000)
	if r.Verdict != Different {
		t.Fatalf("verdict = %v, want different", r.Verdict)
	}
	if r.Witness != "a" {
		t.Fatalf("witness = %q, want %q", r.Witness, "a")
	}
	if !r.Cert.Verify(a, b) {
		t.Fatalf("certificate failed to verify:\n%s", r.Cert)
	}
	// Brute-force cross-check must agree on the same witness.
	w, found := FindDiffBrute(a, b, 4)
	if !found || w != r.Witness {
		t.Fatalf("brute witness = %q (found=%v), want %q", w, found, r.Witness)
	}
}

func TestByteOrderMinimalWitness(t *testing.T) {
	// L1 = {"aa"}, L2 = {"ab"}: both "aa" and "ab" distinguish at length
	// 2; the byte-order minimal one is "aa".
	a, b := exactly("aa"), exactly("ab")
	r := Compare(a, b, 10000)
	if r.Verdict != Different || r.Witness != "aa" {
		t.Fatalf("verdict=%v witness=%q, want different/\"aa\"", r.Verdict, r.Witness)
	}
	if !r.Cert.Verify(a, b) {
		t.Fatalf("certificate failed to verify:\n%s", r.Cert)
	}
	w, found := FindDiffBrute(a, b, 3)
	if !found || w != "aa" {
		t.Fatalf("brute witness = %q (found=%v), want \"aa\"", w, found)
	}
}

func TestEmptyWitness(t *testing.T) {
	// One accepts the empty string, the other does not.
	a, b := exactly(""), exactly("a")
	r := Compare(a, b, 10000)
	if r.Verdict != Different || r.Witness != "" {
		t.Fatalf("verdict=%v witness=%q, want different/\"\"", r.Verdict, r.Witness)
	}
	if !r.Cert.Verify(a, b) {
		t.Fatalf("certificate failed to verify:\n%s", r.Cert)
	}
}

func TestBudgetExhaustedUnknown(t *testing.T) {
	// Zero budget: nothing may be expanded, so unless the search needs no
	// expansion the result must be unknown.
	r := Compare(allAB(), allABThompson(), 0)
	if r.Verdict != Unknown {
		t.Fatalf("verdict = %v, want unknown", r.Verdict)
	}
	// Budget of 1 lets the start pair be checked but not closed.
	r = Compare(allAB(), allABThompson(), 1)
	if r.Verdict != Unknown {
		t.Fatalf("verdict = %v, want unknown", r.Verdict)
	}
	if r.Expanded != 1 {
		t.Fatalf("expanded = %d, want 1", r.Expanded)
	}
}

func TestBudgetSufficient(t *testing.T) {
	// A generous budget must close the search and prove equivalence.
	r := Compare(allAB(), allABThompson(), 1000)
	if r.Verdict != Equivalent {
		t.Fatalf("verdict = %v, want equivalent", r.Verdict)
	}
}

func TestCertificateChain(t *testing.T) {
	// L1 = even-length a-strings, L2 = all a-strings; witness "a".
	even := New(2, 0)
	even.Accept[0] = true
	even.AddEdge(0, 'a', 1)
	even.AddEdge(1, 'a', 0)
	odd := New(1, 0)
	odd.Accept[0] = true
	odd.AddEdge(0, 'a', 0)

	r := Compare(even, odd, 1000)
	if r.Verdict != Different || r.Witness != "a" {
		t.Fatalf("verdict=%v witness=%q, want different/\"a\"", r.Verdict, r.Witness)
	}
	if len(r.Cert.Steps) != 1 {
		t.Fatalf("certificate has %d steps, want 1", len(r.Cert.Steps))
	}
	st := r.Cert.Steps[0]
	if st.Symbol != 'a' || !eqInts(st.FromA, []int{0}) || !eqInts(st.ToA, []int{1}) {
		t.Fatalf("unexpected certificate step: %+v", st)
	}
	if !r.Cert.Verify(even, odd) {
		t.Fatalf("certificate failed to verify:\n%s", r.Cert)
	}
}

func TestCrossCheckRandomSmall(t *testing.T) {
	// Deterministic pseudo-random small NFAs; cross-check Compare against
	// brute-force enumeration on every pair.
	rng := uint32(12345)
	next := func(n int) int {
		rng = rng*1664525 + 1013904223
		return int(rng >> 16 % uint32(n))
	}
	build := func() *NFA {
		ns := 1 + next(4)
		n := New(ns, 0)
		for s := 0; s < ns; s++ {
			if next(2) == 0 {
				n.Accept[s] = true
			}
			for _, c := range []byte{'a', 'b'} {
				for k := next(3); k > 0; k-- {
					n.AddEdge(s, c, next(ns))
				}
			}
			if next(3) == 0 {
				n.AddEpsilon(s, next(ns))
			}
		}
		return n
	}
	for trial := 0; trial < 20; trial++ {
		a, b := build(), build()
		r := Compare(a, b, 100000)
		w, found := FindDiffBrute(a, b, 8)
		switch r.Verdict {
		case Different:
			if !found {
				t.Fatalf("trial %d: Compare found %q but brute force found nothing", trial, r.Witness)
			}
			if w != r.Witness {
				t.Fatalf("trial %d: witness %q != brute %q", trial, r.Witness, w)
			}
			if !r.Cert.Verify(a, b) {
				t.Fatalf("trial %d: certificate failed to verify:\n%s", trial, r.Cert)
			}
			if a.Eval(r.Witness) == b.Eval(r.Witness) {
				t.Fatalf("trial %d: witness %q does not distinguish", trial, r.Witness)
			}
		case Equivalent:
			if found {
				t.Fatalf("trial %d: Compare says equivalent but brute found %q", trial, w)
			}
		default:
			t.Fatalf("trial %d: unexpected unknown with large budget", trial)
		}
	}
}
