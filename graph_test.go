package ratiograph

import (
	"errors"
	"math/big"
	"math/rand"
	"reflect"
	"testing"
)

func weightsOf(comps []Component, verts ...int) []*big.Int {
	out := make([]*big.Int, len(verts))
	for i, v := range verts {
		for _, c := range comps {
			if w := c.Weight(v); w != nil {
				out[i] = w
				break
			}
		}
		if out[i] == nil {
			panic("vertex not found in components")
		}
	}
	return out
}

func bigs(vals ...int64) []*big.Int {
	out := make([]*big.Int, len(vals))
	for i, v := range vals {
		out[i] = big.NewInt(v)
	}
	return out
}

// checkEdge verifies w_u / w_v == Num / Den against the returned vectors.
func checkEdge(t *testing.T, comps []Component, e Edge) {
	t.Helper()
	ce := e.canonical()
	w := weightsOf(comps, ce.U, ce.V)
	got := new(big.Rat).SetFrac(w[0], w[1])
	want := big.NewRat(ce.Num, ce.Den)
	if got.Cmp(want) != 0 {
		t.Fatalf("edge %s violated: weight ratio %s", ce, got.RatString())
	}
}

// checkSimplest verifies every component's weights are positive and coprime.
func checkSimplest(t *testing.T, comps []Component) {
	t.Helper()
	for _, c := range comps {
		g := new(big.Int)
		for _, w := range c.Weights {
			if w.Sign() <= 0 {
				t.Fatalf("non-positive weight %s in %v", w, c.Vertices)
			}
			g.GCD(nil, nil, g, w)
		}
		if g.Cmp(big.NewInt(1)) != 0 {
			t.Fatalf("component %v weights not coprime, gcd=%s", c.Vertices, g)
		}
	}
}

// checkCertificate validates the certificate structure: a directed closed
// walk of existing edges whose multipliers multiply to Product != 1.
func checkCertificate(t *testing.T, cert *Certificate, edgeSet map[Edge]struct{}) {
	t.Helper()
	if len(cert.Steps) == 0 {
		t.Fatal("empty certificate")
	}
	prod := big.NewRat(1, 1)
	for i, s := range cert.Steps {
		if i+1 < len(cert.Steps) && s.To != cert.Steps[i+1].From {
			t.Fatalf("steps do not form a walk at %d", i)
		}
		ce := s.Edge.canonical()
		if _, ok := edgeSet[ce]; !ok {
			t.Fatalf("certificate uses absent edge %s", ce)
		}
		var want *big.Rat
		switch {
		case s.From == ce.U && s.To == ce.V:
			want = big.NewRat(ce.Den, ce.Num)
		case s.From == ce.V && s.To == ce.U:
			want = big.NewRat(ce.Num, ce.Den)
		default:
			t.Fatalf("step x%d->x%d does not match edge %s", s.From, s.To, ce)
		}
		if s.Mult.Cmp(want) != 0 {
			t.Fatalf("step mult %s, want %s", s.Mult.RatString(), want.RatString())
		}
		prod.Mul(prod, s.Mult)
	}
	if cert.Steps[0].From != cert.Steps[len(cert.Steps)-1].To {
		t.Fatal("walk is not closed")
	}
	if prod.Cmp(cert.Product) != 0 {
		t.Fatalf("product %s, want %s", cert.Product.RatString(), prod.RatString())
	}
	if cert.Product.Cmp(big.NewRat(1, 1)) == 0 {
		t.Fatal("certificate product must differ from 1")
	}
}

func edgeSet(es []Edge) map[Edge]struct{} {
	out := make(map[Edge]struct{}, len(es))
	for _, e := range es {
		out[e.canonical()] = struct{}{}
	}
	return out
}

func TestSingleComponentVector(t *testing.T) {
	g := New()
	comps, cert, err := g.Apply([]Edge{
		{U: 1, V: 2, Num: 1, Den: 2}, // x2 = 2 x1
		{U: 2, V: 3, Num: 2, Den: 3}, // x3 = 3/2 x2 = 3 x1
	}, nil)
	if err != nil || cert != nil {
		t.Fatalf("err=%v cert=%v", err, cert)
	}
	if len(comps) != 1 {
		t.Fatalf("got %d components, want 1", len(comps))
	}
	got := weightsOf(comps, 1, 2, 3)
	if !reflect.DeepEqual(got, bigs(1, 2, 3)) {
		t.Fatalf("weights %v, want [1 2 3]", got)
	}
}

func TestUnreducedRatioIsNormalized(t *testing.T) {
	g := New()
	comps, cert, err := g.Apply([]Edge{{U: 1, V: 2, Num: 2, Den: 4}}, nil)
	if err != nil || cert != nil {
		t.Fatalf("err=%v cert=%v", err, cert)
	}
	if got := weightsOf(comps, 1, 2); !reflect.DeepEqual(got, bigs(1, 2)) {
		t.Fatalf("weights %v, want [1 2]", got)
	}
}

func TestDisconnectedComponents(t *testing.T) {
	g := New()
	comps, cert, err := g.Apply([]Edge{
		{U: 1, V: 2, Num: 3, Den: 1},
		{U: 7, V: 8, Num: 1, Den: 5},
	}, nil)
	if err != nil || cert != nil {
		t.Fatalf("err=%v cert=%v", err, cert)
	}
	if len(comps) != 2 {
		t.Fatalf("got %d components, want 2", len(comps))
	}
	if got := weightsOf(comps, 1, 2); !reflect.DeepEqual(got, bigs(3, 1)) {
		t.Fatalf("weights %v, want [3 1]", got)
	}
	if got := weightsOf(comps, 7, 8); !reflect.DeepEqual(got, bigs(1, 5)) {
		t.Fatalf("weights %v, want [1 5]", got)
	}
}

func TestInconsistentCycleCertificate(t *testing.T) {
	g := New()
	good := []Edge{
		{U: 1, V: 2, Num: 1, Den: 2},
		{U: 2, V: 3, Num: 1, Den: 3},
	}
	if _, cert, err := g.Apply(good, nil); err != nil || cert != nil {
		t.Fatalf("setup: err=%v cert=%v", err, cert)
	}
	before := g.Edges()

	// x1/x3 must be 1/6; claim 1/5 instead.
	_, cert, err := g.Apply([]Edge{{U: 1, V: 3, Num: 1, Den: 5}}, nil)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if cert == nil {
		t.Fatal("expected certificate")
	}
	checkCertificate(t, cert, edgeSet(append(good, Edge{U: 1, V: 3, Num: 1, Den: 5})))
	if !reflect.DeepEqual(g.Edges(), before) {
		t.Fatal("graph mutated despite rejected batch")
	}
}

func TestAtomicBatchRollbackAndCommit(t *testing.T) {
	g := New()
	if _, cert, err := g.Apply([]Edge{
		{U: 1, V: 2, Num: 1, Den: 2},
		{U: 5, V: 6, Num: 1, Den: 1},
	}, nil); err != nil || cert != nil {
		t.Fatalf("setup: err=%v cert=%v", err, cert)
	}
	before := g.Edges()

	// Batch mixes valid removals/additions with one contradictory edge:
	// the whole batch must be discarded.
	_, cert, err := g.Apply(
		[]Edge{
			{U: 3, V: 4, Num: 2, Den: 3},
			{U: 1, V: 2, Num: 7, Den: 9}, // parallel to and contradicts x1/x2 = 1/2
		},
		[]Edge{{U: 5, V: 6, Num: 1, Den: 1}},
	)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if cert == nil {
		t.Fatal("expected certificate")
	}
	if !reflect.DeepEqual(g.Edges(), before) {
		t.Fatalf("graph mutated despite rejected batch: %v", g.Edges())
	}

	// A consistent batch commits in full.
	comps, cert, err := g.Apply(
		[]Edge{{U: 2, V: 3, Num: 2, Den: 3}},
		nil,
	)
	if err != nil || cert != nil {
		t.Fatalf("err=%v cert=%v", err, cert)
	}
	if got := weightsOf(comps, 1, 2, 3); !reflect.DeepEqual(got, bigs(1, 2, 3)) {
		t.Fatalf("weights %v, want [1 2 3]", got)
	}
}

func TestBatchRemovalSplitsComponent(t *testing.T) {
	g := New()
	edges := []Edge{
		{U: 1, V: 2, Num: 1, Den: 2},
		{U: 2, V: 3, Num: 2, Den: 3},
	}
	if _, cert, err := g.Apply(edges, nil); err != nil || cert != nil {
		t.Fatalf("setup: err=%v cert=%v", err, cert)
	}
	comps, cert, err := g.Apply(nil, []Edge{{U: 2, V: 3, Num: 4, Den: 6}}) // same edge, unreduced
	if err != nil || cert != nil {
		t.Fatalf("err=%v cert=%v", err, cert)
	}
	if len(comps) != 2 {
		t.Fatalf("got %d components, want 2", len(comps))
	}
	if got := weightsOf(comps, 1, 2); !reflect.DeepEqual(got, bigs(1, 2)) {
		t.Fatalf("weights %v, want [1 2]", got)
	}
	if got := weightsOf(comps, 3); !reflect.DeepEqual(got, bigs(1)) {
		t.Fatalf("weights %v, want [1]", got)
	}
}

func TestSelfLoopContradiction(t *testing.T) {
	g := New()
	_, cert, err := g.Apply([]Edge{{U: 5, V: 5, Num: 1, Den: 2}}, nil)
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if cert == nil {
		t.Fatal("expected certificate")
	}
	checkCertificate(t, cert, edgeSet([]Edge{{U: 5, V: 5, Num: 1, Den: 2}}))
	if len(g.Edges()) != 0 {
		t.Fatal("graph mutated despite rejected batch")
	}
}

func TestRemoveMissingEdge(t *testing.T) {
	g := New()
	if _, cert, err := g.Apply([]Edge{{U: 1, V: 2, Num: 1, Den: 2}}, nil); err != nil || cert != nil {
		t.Fatalf("setup: err=%v cert=%v", err, cert)
	}
	before := g.Edges()
	_, _, err := g.Apply(nil, []Edge{{U: 9, V: 10, Num: 1, Den: 1}})
	if !errors.Is(err, ErrEdgeNotFound) {
		t.Fatalf("err=%v, want ErrEdgeNotFound", err)
	}
	if !reflect.DeepEqual(g.Edges(), before) {
		t.Fatal("graph mutated despite failed batch")
	}
}

func TestInvalidRatioRejected(t *testing.T) {
	g := New()
	if _, _, err := g.Apply([]Edge{{U: 1, V: 2, Num: 0, Den: 1}}, nil); err == nil {
		t.Fatal("expected error for non-positive ratio")
	}
	if _, _, err := g.Apply([]Edge{{U: 1, V: 2, Num: -1, Den: 2}}, nil); err == nil {
		t.Fatal("expected error for negative ratio")
	}
}

// TestFullGraphPotentialPropagation drives random atomic batches and, after
// every committed batch, re-verifies the entire graph from scratch: every
// live edge must hold under the reported integer vectors, and every
// component vector must be in simplest form. Rejected batches must leave
// the edge set untouched and carry a valid cycle certificate.
func TestFullGraphPotentialPropagation(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	const nVerts = 12
	g := New()
	live := map[Edge]struct{}{}

	// Hidden model potentials keep most random batches consistent.
	model := make([]int64, nVerts)
	for i := range model {
		model[i] = int64(1 + rng.Intn(9))
	}

	for iter := 0; iter < 300; iter++ {
		var adds, removes []Edge
		for e := range live {
			if rng.Intn(8) == 0 {
				removes = append(removes, e)
			}
		}
		for k := 0; k < 3; k++ {
			u, v := rng.Intn(nVerts), rng.Intn(nVerts)
			num, den := model[u], model[v]
			if rng.Intn(10) == 0 {
				num++ // corrupt: may close an inconsistent cycle
			}
			adds = append(adds, Edge{U: u, V: v, Num: num, Den: den})
		}

		before := g.Edges()
		comps, cert, err := g.Apply(adds, removes)
		if err != nil {
			t.Fatalf("iter %d: unexpected error %v", iter, err)
		}
		if cert != nil {
			if !reflect.DeepEqual(g.Edges(), before) {
				t.Fatalf("iter %d: graph mutated despite rejected batch", iter)
			}
			union := edgeSet(append(before, adds...))
			checkCertificate(t, cert, union)
			continue
		}
		for _, e := range removes {
			delete(live, e.canonical())
		}
		for _, e := range adds {
			live[e.canonical()] = struct{}{}
		}
		if got := edgeSet(g.Edges()); !reflect.DeepEqual(got, live) {
			t.Fatalf("iter %d: committed edge set mismatch", iter)
		}
		// Full-graph verification: every live edge must hold exactly.
		for e := range live {
			checkEdge(t, comps, e)
		}
		checkSimplest(t, comps)
	}
}
