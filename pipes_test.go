package pipes

import (
	"errors"
	"math/big"
	"testing"
)

func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("bad rational: " + s)
	}
	return s2(r)
}

func s2(r *big.Rat) *big.Rat { return r }

func headBC(h string) BC { return BC{Head: rat(h)} }
func injBC(d string) BC  { return BC{Injection: rat(d)} }
func mustSolve(t *testing.T, net *Network, bcs []BC) *Solution {
	t.Helper()
	sol, err := Solve(net, bcs)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	return sol
}

func mustCheck(t *testing.T, net *Network, bcs []BC, sol *Solution) {
	t.Helper()
	if bad := CheckSolution(net, bcs, sol); len(bad) > 0 {
		t.Fatalf("checker rejected solution: %v", bad)
	}
}

func TestTwoNodeAnchored(t *testing.T) {
	net := &Network{N: 2, Edges: []Edge{{From: 0, To: 1, R: rat("2")}}}
	bcs := []BC{headBC("10"), injBC("-3")}
	sol := mustSolve(t, net, bcs)
	if !sol.Unique {
		t.Fatal("expected unique solution")
	}
	if sol.Pressures[0].Cmp(rat("10")) != 0 || sol.Pressures[1].Cmp(rat("4")) != 0 {
		t.Fatalf("pressures = %v, %v", sol.Pressures[0], sol.Pressures[1])
	}
	if sol.Flows[0].Cmp(rat("3")) != 0 {
		t.Fatalf("flow = %v", sol.Flows[0])
	}
	mustCheck(t, net, bcs, sol)
}

func TestRationalCoefficients(t *testing.T) {
	net := &Network{N: 3, Edges: []Edge{
		{From: 0, To: 1, R: rat("2/3")},
		{From: 1, To: 2, R: rat("5/7")},
	}}
	bcs := []BC{headBC("11/2"), injBC("0"), injBC("-4/3")}
	sol := mustSolve(t, net, bcs)
	if !sol.Unique {
		t.Fatal("expected unique solution")
	}
	// q = 4/3 on both edges; p1 = 11/2 - (2/3)(4/3) = 83/18;
	// p2 = 83/18 - (5/7)(4/3) = 461/126.
	if sol.Pressures[1].Cmp(rat("83/18")) != 0 {
		t.Fatalf("p1 = %s", sol.Pressures[1].RatString())
	}
	if sol.Pressures[2].Cmp(rat("461/126")) != 0 {
		t.Fatalf("p2 = %s", sol.Pressures[2].RatString())
	}
	mustCheck(t, net, bcs, sol)
}

func TestUnanchoredComponentNullspace(t *testing.T) {
	net := &Network{N: 2, Edges: []Edge{{From: 0, To: 1, R: rat("1")}}}
	bcs := []BC{injBC("1"), injBC("-1")}
	sol := mustSolve(t, net, bcs)
	if sol.Unique {
		t.Fatal("expected non-unique solution")
	}
	if len(sol.Nullspace) != 1 {
		t.Fatalf("nullity = %d, want 1", len(sol.Nullspace))
	}
	v := sol.Nullspace[0]
	// Null vector must be constant pressure, zero flow.
	if v[0].Cmp(v[1]) != 0 || v[0].Sign() == 0 {
		t.Fatalf("null vector pressures = %s, %s", v[0], v[1])
	}
	if v[2].Sign() != 0 {
		t.Fatalf("null vector flow = %s", v[2])
	}
	if bad := CheckNullVector(net, bcs, v); len(bad) > 0 {
		t.Fatalf("null evidence rejected: %v", bad)
	}
	// Shifting the solution by a null vector keeps it valid.
	shifted := &Solution{
		Pressures: []*big.Rat{
			new(big.Rat).Add(sol.Pressures[0], v[0]),
			new(big.Rat).Add(sol.Pressures[1], v[1]),
		},
		Flows: []*big.Rat{new(big.Rat).Add(sol.Flows[0], v[2])},
	}
	mustCheck(t, net, bcs, shifted)
	mustCheck(t, net, bcs, sol)
}

func TestInconsistentUnanchored(t *testing.T) {
	net := &Network{N: 2, Edges: []Edge{{From: 0, To: 1, R: rat("1")}}}
	bcs := []BC{injBC("1"), injBC("1")}
	_, err := Solve(net, bcs)
	var inc *InconsistentError
	if !errors.As(err, &inc) {
		t.Fatalf("err = %v, want InconsistentError", err)
	}
}

func TestCheckerRejectsBadSolution(t *testing.T) {
	net := &Network{N: 2, Edges: []Edge{{From: 0, To: 1, R: rat("2")}}}
	bcs := []BC{headBC("10"), injBC("-3")}
	sol := mustSolve(t, net, bcs)
	sol.Pressures[1] = new(big.Rat).Add(sol.Pressures[1], big.NewRat(1, 2))
	bad := CheckSolution(net, bcs, sol)
	if len(bad) == 0 {
		t.Fatal("checker accepted a perturbed solution")
	}
	if bad[0].Value.Cmp(rat("-1/2")) != 0 {
		t.Fatalf("residual = %s, want -1/2", bad[0].Value.RatString())
	}
}

func TestCheckerRejectsBadNullVector(t *testing.T) {
	net := &Network{N: 2, Edges: []Edge{{From: 0, To: 1, R: rat("1")}}}
	bcs := []BC{injBC("1"), injBC("-1")}
	v := []*big.Rat{rat("1"), rat("1"), rat("1")} // nonzero flow part
	if bad := CheckNullVector(net, bcs, v); len(bad) == 0 {
		t.Fatal("checker accepted a non-null vector")
	}
}

func TestTriangleLoop(t *testing.T) {
	net := &Network{N: 3, Edges: []Edge{
		{From: 0, To: 1, R: rat("1")},
		{From: 1, To: 2, R: rat("1")},
		{From: 0, To: 2, R: rat("2")},
	}}
	bcs := []BC{headBC("6"), injBC("0"), injBC("-4")}
	sol := mustSolve(t, net, bcs)
	if !sol.Unique {
		t.Fatal("expected unique solution")
	}
	// Node 1 is a transit node: q01 = q12. Let q01 = a, q02 = b.
	// a + b = 4; p1 = 6 - a; p2 = 6 - 2b = p1 - a => 6-2b = 6-2a
	// => a = b = 2. p1 = 4, p2 = 2.
	want := []string{"6", "4", "2"}
	for i, w := range want {
		if sol.Pressures[i].Cmp(rat(w)) != 0 {
			t.Fatalf("p%d = %s, want %s", i, sol.Pressures[i], w)
		}
	}
	mustCheck(t, net, bcs, sol)
}

func TestEightNodes(t *testing.T) {
	// Path graph 0-1-...-7, anchor at 0, unit draw at 7.
	var edges []Edge
	for i := 0; i < 7; i++ {
		edges = append(edges, Edge{From: i, To: i + 1, R: rat("3/2")})
	}
	net := &Network{N: 8, Edges: edges}
	bcs := []BC{headBC("21")}
	for i := 1; i < 7; i++ {
		bcs = append(bcs, injBC("0"))
	}
	bcs = append(bcs, injBC("-2"))
	sol := mustSolve(t, net, bcs)
	if !sol.Unique {
		t.Fatal("expected unique solution")
	}
	// q = 2 everywhere; p_i = 21 - 3i.
	for i := 0; i < 8; i++ {
		want := rat("21")
		want.Sub(want, new(big.Rat).SetInt64(int64(3*i)))
		if sol.Pressures[i].Cmp(want) != 0 {
			t.Fatalf("p%d = %s, want %s", i, sol.Pressures[i], want)
		}
	}
	mustCheck(t, net, bcs, sol)
}

func TestDisconnectedMixedComponents(t *testing.T) {
	// Component A: nodes 0,1 anchored. Component B: nodes 2,3 balanced.
	net := &Network{N: 4, Edges: []Edge{
		{From: 0, To: 1, R: rat("1")},
		{From: 2, To: 3, R: rat("4")},
	}}
	bcs := []BC{headBC("5"), injBC("-2"), injBC("1"), injBC("-1")}
	sol := mustSolve(t, net, bcs)
	if sol.Unique {
		t.Fatal("expected non-unique solution")
	}
	if len(sol.Nullspace) != 1 {
		t.Fatalf("nullity = %d, want 1", len(sol.Nullspace))
	}
	v := sol.Nullspace[0]
	if bad := CheckNullVector(net, bcs, v); len(bad) > 0 {
		t.Fatalf("null evidence rejected: %v", bad)
	}
	// Null vector must vanish on anchored component A.
	if v[0].Sign() != 0 || v[1].Sign() != 0 {
		t.Fatalf("null vector nonzero on anchored component: %v", v)
	}
	mustCheck(t, net, bcs, sol)
}

func TestValidation(t *testing.T) {
	if err := Validate(&Network{N: 9}, make([]BC, 9)); err == nil {
		t.Fatal("accepted 9 nodes")
	}
	net := &Network{N: 1}
	if err := Validate(net, []BC{{}}); err == nil {
		t.Fatal("accepted empty BC")
	}
	if err := Validate(net, []BC{headBC("1")}); err != nil {
		t.Fatalf("rejected valid single node: %v", err)
	}
	bad := &Network{N: 2, Edges: []Edge{{From: 0, To: 1, R: rat("0")}}}
	if err := Validate(bad, []BC{headBC("1"), injBC("0")}); err == nil {
		t.Fatal("accepted zero resistance")
	}
}
