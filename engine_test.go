package statcorr

import (
	"math/big"
	"strings"
	"testing"
)

func directOverMatching(m Matching) *Stats {
	st := NewStats()
	for _, p := range m.Pairs {
		st.Add(p.A.V, p.B.V)
	}
	return st
}

func TestEngineRecomputesOnMatchingChange(t *testing.T) {
	e := NewEngine(big.NewRat(3, 1))
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(e.UpsertA(pt("a1", 0, 1, 1)))
	must(e.UpsertA(pt("a2", 10, 1, 2)))
	must(e.UpsertB(pt("b1", 1, 1, 3)))

	m1, st1, c1, err := e.Evaluate()
	if err != nil {
		t.Fatal(err)
	}
	if len(m1.Pairs) != 1 {
		t.Fatalf("expected 1 pair, got %s%s", m1.Certificate(), st1.Certificate())
	}
	if c1.Defined {
		t.Fatalf("single aligned pair must be undefined, got %s", c1)
	}

	// Adding b2 changes the matching; correlation must be recomputed.
	must(e.UpsertB(pt("b2", 9, 1, 5)))
	m2, st2, c2, err := e.Evaluate()
	if err != nil {
		t.Fatal(err)
	}
	if len(m2.Pairs) != 2 {
		t.Fatalf("expected 2 pairs, got %s", m2.Certificate())
	}
	if !c2.Defined || c2.String() != "1" {
		t.Fatalf("r = %s, want 1", c2)
	}
	if got, want := st2.Certificate(), directOverMatching(m2).Certificate(); got != want {
		t.Fatalf("engine stats %q != direct %q", got, want)
	}

	// Removing b1 changes the matching again; stats must follow.
	if !e.RemoveB("b1") {
		t.Fatal("RemoveB(b1) = false")
	}
	m3, st3, c3, err := e.Evaluate()
	if err != nil {
		t.Fatal(err)
	}
	if len(m3.Pairs) != 1 || m3.Pairs[0].A.ID != "a2" {
		t.Fatalf("expected only a2~b2, got %s", m3.Certificate())
	}
	if c3.Defined {
		t.Fatalf("single aligned pair must be undefined, got %s", c3)
	}
	if got, want := st3.Certificate(), directOverMatching(m3).Certificate(); got != want {
		t.Fatalf("engine stats %q != direct %q", got, want)
	}
}

func TestEngineCertificateChangesWithMatching(t *testing.T) {
	e := NewEngine(big.NewRat(2, 1))
	e.UpsertA(pt("a1", 0, 1, 1))
	e.UpsertA(pt("a2", 5, 1, 2))
	e.UpsertB(pt("b1", 1, 1, 4))
	e.UpsertB(pt("b2", 4, 1, 5))
	cert1, err := e.Certificate()
	if err != nil {
		t.Fatal(err)
	}
	// Move b1 next to a2: the matching (and hence the stats) must change.
	e.UpsertB(pt("b1", 3, 1, 4))
	cert2, err := e.Certificate()
	if err != nil {
		t.Fatal(err)
	}
	if cert1 == cert2 {
		t.Fatalf("certificate did not change after matching change:\n%s", cert1)
	}
	if !strings.Contains(cert2, "a2(t=5,v=2) <-> b2(t=4,v=5)") {
		t.Fatalf("unexpected matching in certificate:\n%s", cert2)
	}
	if !strings.Contains(cert2, "r=undefined(fewer than two aligned points)") {
		t.Fatalf("expected undefined correlation in certificate:\n%s", cert2)
	}
}

func TestEngineMaxPoints(t *testing.T) {
	e := NewEngine(big.NewRat(1, 1))
	for i := 0; i < MaxPoints; i++ {
		if err := e.UpsertA(pt("a"+string(rune('a'+i)), int64(i), 1, 1)); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.UpsertA(pt("overflow", 100, 1, 1)); err != ErrTooManyPoints {
		t.Fatalf("err = %v, want ErrTooManyPoints", err)
	}
}
