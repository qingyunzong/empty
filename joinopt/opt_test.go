package main

import (
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

func certOf(t *testing.T, sol *Solution, mask uint16) SubCert {
	t.Helper()
	for _, c := range sol.Certs {
		if c.Mask == mask {
			return c
		}
	}
	t.Fatalf("no certificate for mask %b", mask)
	return SubCert{}
}

// Hand-computed 3-table chain A-B-C.
func TestSolveChain3(t *testing.T) {
	p := &Problem{
		Names: []string{"A", "B", "C"},
		Card:  []int64{100, 50, 200},
		Edges: []Edge{{0, 1, 10}, {1, 2, 4}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if !sol.OK {
		t.Fatal("expected solvable")
	}
	// est(AB)=500, est(BC)=2500, est(ABC)=25000.
	if got := certOf(t, sol, 0b011).EstCard; got.Cmp(big.NewInt(500)) != 0 {
		t.Errorf("est(AB) = %v, want 500", got)
	}
	if got := certOf(t, sol, 0b110).EstCard; got.Cmp(big.NewInt(2500)) != 0 {
		t.Errorf("est(BC) = %v, want 2500", got)
	}
	if got := sol.Full.EstCard; got.Cmp(big.NewInt(25000)) != 0 {
		t.Errorf("est(ABC) = %v, want 25000", got)
	}
	// ((A B) C): 500+25000 = 25500 beats (A (B C)): 2500+25000 = 27500.
	if got := sol.Full.Cost; got.Cmp(big.NewInt(25500)) != 0 {
		t.Errorf("cost = %v, want 25500", got)
	}
	if sol.Full.Tree != "((A B) C)" {
		t.Errorf("tree = %q, want %q", sol.Full.Tree, "((A B) C)")
	}
	if sol.Full.Split != 0b011 {
		t.Errorf("split = %b, want 011", sol.Full.Split)
	}
}

// Hand-computed 4-table chain; the bushy split (AB)(CD) wins.
func TestSolveChain4Bushy(t *testing.T) {
	p := &Problem{
		Names: []string{"A", "B", "C", "D"},
		Card:  []int64{10, 20, 30, 40},
		Edges: []Edge{{0, 1, 2}, {1, 2, 3}, {2, 3, 5}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	// est(AB)=100, est(CD)=240, est(ABCD)=8000 -> 8340 via {A,B}|{C,D}.
	if got := sol.Full.Cost; got.Cmp(big.NewInt(8340)) != 0 {
		t.Errorf("cost = %v, want 8340", got)
	}
	if sol.Full.Tree != "((A B) (C D))" {
		t.Errorf("tree = %q, want %q", sol.Full.Tree, "((A B) (C D))")
	}
	if sol.Full.Split != 0b0011 {
		t.Errorf("split = %b, want 0011", sol.Full.Split)
	}
}

// Symmetric triangle: all plans tie on cost; canonical order must win.
func TestCanonicalTieBreak(t *testing.T) {
	p := &Problem{
		Names: []string{"A", "B", "C"},
		Card:  []int64{10, 10, 10},
		Edges: []Edge{{0, 1, 1}, {1, 2, 1}, {0, 2, 1}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := sol.Full.Cost; got.Cmp(big.NewInt(1100)) != 0 {
		t.Errorf("cost = %v, want 1100", got)
	}
	if sol.Full.Tree != "((A B) C)" {
		t.Errorf("tree = %q, want canonical %q", sol.Full.Tree, "((A B) C)")
	}
}

// estCard floors the exact quotient and never drops below 1.
func TestEstCardFloorAndMinOne(t *testing.T) {
	p := &Problem{
		Names: []string{"A", "B"},
		Card:  []int64{3, 1},
		Edges: []Edge{{0, 1, 2}},
	}
	if got := estCard(p, 0b11); got.Cmp(big.NewInt(1)) != 0 {
		t.Errorf("floor(3/2) = %v, want 1", got)
	}
	p.Card = []int64{1, 1}
	p.Edges = []Edge{{0, 1, 5}}
	if got := estCard(p, 0b11); got.Cmp(big.NewInt(1)) != 0 {
		t.Errorf("floor(1/5) clamped = %v, want 1", got)
	}
}

// Disconnected join graph has no legal tree.
func TestDisconnectedRejected(t *testing.T) {
	p := &Problem{
		Names: []string{"A", "B", "C"},
		Card:  []int64{10, 10, 10},
		Edges: []Edge{{0, 1, 1}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if sol.OK {
		t.Error("expected OK=false for disconnected graph")
	}
	if _, _, err := BruteForce(p); err == nil {
		t.Error("expected brute force to reject disconnected graph")
	}
}

// Single table: zero cost, tree is the table itself.
func TestSingleTable(t *testing.T) {
	p := &Problem{Names: []string{"A"}, Card: []int64{42}}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	if !sol.OK || sol.Full.Cost.Sign() != 0 || sol.Full.Tree != "A" {
		t.Errorf("got ok=%v cost=%v tree=%q", sol.OK, sol.Full.Cost, sol.Full.Tree)
	}
	cost, tree, err := BruteForce(p)
	if err != nil || cost.Sign() != 0 || tree != "A" {
		t.Errorf("brute: cost=%v tree=%q err=%v", cost, tree, err)
	}
}

// randomConnected builds a random connected join graph on n tables.
func randomConnected(rng *rand.Rand, n int) *Problem {
	p := &Problem{Names: make([]string, n), Card: make([]int64, n)}
	for i := 0; i < n; i++ {
		p.Names[i] = string(rune('A' + i))
		p.Card[i] = int64(1 + rng.Intn(1000000))
	}
	for i := 1; i < n; i++ { // spanning tree guarantees connectivity
		j := rng.Intn(i)
		p.Edges = append(p.Edges, Edge{i, j, int64(1 + rng.Intn(50))})
	}
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if rng.Float64() < 0.35 {
				dup := false
				for _, e := range p.Edges {
					if (e.U == i && e.V == j) || (e.U == j && e.V == i) {
						dup = true
						break
					}
				}
				if !dup {
					p.Edges = append(p.Edges, Edge{i, j, int64(1 + rng.Intn(50))})
				}
			}
		}
	}
	return p
}

// Cross-check the DP against exhaustive enumeration of all legal join trees,
// for the full set and for every connected subset, on random small graphs.
func TestDPvsBruteForceRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	counts := map[int]int{2: 40, 3: 40, 4: 40, 5: 30, 6: 20, 7: 6, 8: 2}
	for n, num := range counts {
		for k := 0; k < num; k++ {
			p := randomConnected(rng, n)
			sol, err := Solve(p)
			if err != nil {
				t.Fatalf("n=%d: %v", n, err)
			}
			if !sol.OK {
				t.Fatalf("n=%d: connected graph reported unsolvable", n)
			}
			memo, err := brutePlans(p)
			if err != nil {
				t.Fatalf("n=%d: %v", n, err)
			}
			for _, c := range sol.Certs {
				brute, ok := memo[c.Mask]
				if !ok || len(brute) == 0 {
					t.Fatalf("n=%d mask=%b: brute found no tree", n, c.Mask)
				}
				b := bestOf(brute)
				if b.cost.Cmp(c.Cost) != 0 || b.tree != c.Tree {
					t.Errorf("n=%d mask=%b: dp=(%v %q) brute=(%v %q)",
						n, c.Mask, c.Cost, c.Tree, b.cost, b.tree)
				}
				// The certificate's est-card must match the model definition.
				if want := estCard(p, c.Mask); want.Cmp(c.EstCard) != 0 {
					t.Errorf("n=%d mask=%b: est-card %v, model says %v",
						n, c.Mask, c.EstCard, want)
				}
			}
		}
	}
}

func TestReadProblem(t *testing.T) {
	good := "3\nA 100\nB 50\nC 200\n2\nA B 10\nB C 4\n"
	p, err := readProblem(strings.NewReader(good))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Names) != 3 || len(p.Edges) != 2 || p.Edges[0].D != 10 {
		t.Errorf("parsed %+v", p)
	}
	bad := []string{
		"0\n0\n", // too few tables
		"13\n" + strings.Repeat("T 1\n", 13) + "0\n", // too many tables
		"2\nA 0\nB 1\n0\n",                           // non-positive cardinality
		"2\nA 1\nA 1\n0\n",                           // duplicate name
		"2\nA 1\nB 1\n1\nA A 1\n",                    // self edge
		"2\nA 1\nB 1\n1\nA B 0\n",                    // zero divisor
		"2\nA 1\nB 1\n2\nA B 1\nB A 2\n",             // duplicate edge
		"2\nA 1\nB 1\n1\nA C 1\n",                    // unknown table
	}
	for _, in := range bad {
		if _, err := readProblem(strings.NewReader(in)); err == nil {
			t.Errorf("expected error for input %q", in)
		}
	}
}

// Certificate split must reconstruct the canonical tree.
func TestCertificateReconstructsTree(t *testing.T) {
	p := &Problem{
		Names: []string{"A", "B", "C", "D"},
		Card:  []int64{10, 20, 30, 40},
		Edges: []Edge{{0, 1, 2}, {1, 2, 3}, {2, 3, 5}},
	}
	sol, err := Solve(p)
	if err != nil {
		t.Fatal(err)
	}
	certByMask := map[uint16]SubCert{}
	for _, c := range sol.Certs {
		certByMask[c.Mask] = c
	}
	var rebuild func(mask uint16) string
	rebuild = func(mask uint16) string {
		c := certByMask[mask]
		if c.Split == 0 {
			return p.MaskString(mask)[1 : len(p.MaskString(mask))-1] // singleton name
		}
		return canon(rebuild(c.Split), rebuild(mask^c.Split))
	}
	if got := rebuild(sol.Full.Mask); got != sol.Full.Tree {
		t.Errorf("rebuilt %q, certificate tree %q", got, sol.Full.Tree)
	}
}
