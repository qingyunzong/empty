package pipenet

import (
	"math/big"
	"strings"
	"testing"
)

func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("bad rational: " + s)
	}
	return r
}

func rats(ss ...string) []*big.Rat {
	out := make([]*big.Rat, len(ss))
	for i, s := range ss {
		out[i] = rat(s)
	}
	return out
}

func eqRat(t *testing.T, got *big.Rat, want string) {
	t.Helper()
	if got.Cmp(rat(want)) != 0 {
		t.Fatalf("got %s, want %s", got.RatString(), want)
	}
}

func TestTwoNodeHeadInjection(t *testing.T) {
	net := &Network{
		Nodes: []Node{
			{Kind: Head, Value: rat("10")},
			{Kind: Injection, Value: rat("3")},
		},
		Edges: []Edge{{U: 0, V: 1, R: rat("2")}},
	}
	sol, err := Solve(net)
	if err != nil {
		t.Fatal(err)
	}
	// Injection at node 1 exits through the pipe toward the head
	// node: flow 1->0 equals 3, so p1 = 10 + 2*3 = 16.
	eqRat(t, sol.Pressures[0], "10")
	eqRat(t, sol.Pressures[1], "16")
	eqRat(t, sol.Flows[0], "-3")
	eqRat(t, sol.Injections[0], "-3") // head node absorbs the 3 units
	eqRat(t, sol.Injections[1], "3")
	if len(sol.NullSpace) != 0 {
		t.Fatalf("anchored network must have empty null space, got %d vectors", len(sol.NullSpace))
	}
	if rep := Check(net, sol); !rep.OK() {
		t.Fatalf("checker rejected valid solution: %+v", rep.Violations)
	}
}

func TestTriangleExactRationals(t *testing.T) {
	net := &Network{
		Nodes: []Node{
			{Kind: Head, Value: rat("1")},
			{Kind: Injection, Value: rat("0")},
			{Kind: Injection, Value: rat("-7/2")},
		},
		Edges: []Edge{
			{U: 0, V: 1, R: rat("1/3")},
			{U: 1, V: 2, R: rat("2")},
			{U: 0, V: 2, R: rat("1")},
		},
	}
	sol, err := Solve(net)
	if err != nil {
		t.Fatal(err)
	}
	// Hand-solved: p1 = 13/20, p2 = -29/20.
	eqRat(t, sol.Pressures[1], "13/20")
	eqRat(t, sol.Pressures[2], "-29/20")
	eqRat(t, sol.Flows[0], "21/20")
	eqRat(t, sol.Flows[1], "21/20")
	eqRat(t, sol.Flows[2], "49/20")
	eqRat(t, sol.Injections[0], "7/2")
	if rep := Check(net, sol); !rep.OK() {
		t.Fatalf("checker rejected valid solution: %+v", rep.Violations)
	}
}

func TestUnanchoredComponentNullSpace(t *testing.T) {
	net := &Network{
		Nodes: []Node{
			{Kind: Injection, Value: rat("-5")},
			{Kind: Injection, Value: rat("5")},
		},
		Edges: []Edge{{U: 0, V: 1, R: rat("1/2")}},
	}
	sol, err := Solve(net)
	if err != nil {
		t.Fatal(err)
	}
	if len(sol.NullSpace) != 1 {
		t.Fatalf("want 1 null-space vector, got %d", len(sol.NullSpace))
	}
	v := sol.NullSpace[0]
	eqRat(t, v[0], "1")
	eqRat(t, v[1], "1")
	// Particular solution grounds node 0: p = (0, 5/2), flow = -5
	// (5 units enter at node 1 and leave at node 0).
	eqRat(t, sol.Pressures[0], "0")
	eqRat(t, sol.Pressures[1], "5/2")
	eqRat(t, sol.Flows[0], "-5")
	if rep := Check(net, sol); !rep.OK() {
		t.Fatalf("checker rejected valid solution: %+v", rep.Violations)
	}
	// Shifting pressures along the null space must remain a solution.
	shifted := &Solution{
		Pressures:  []*big.Rat{rat("7"), rat("19/2")},
		Flows:      sol.Flows,
		Injections: sol.Injections,
		NullSpace:  sol.NullSpace,
	}
	if rep := Check(net, shifted); !rep.OK() {
		t.Fatalf("checker rejected null-space-shifted solution: %+v", rep.Violations)
	}
}

func TestUnanchoredInconsistent(t *testing.T) {
	net := &Network{
		Nodes: []Node{
			{Kind: Injection, Value: rat("1")},
			{Kind: Injection, Value: rat("1")},
		},
		Edges: []Edge{{U: 0, V: 1, R: rat("1")}},
	}
	_, err := Solve(net)
	if err == nil || !strings.Contains(err.Error(), "unbalanced") {
		t.Fatalf("want unbalanced-injection error, got %v", err)
	}
}

func TestIsolatedNodes(t *testing.T) {
	net := &Network{
		Nodes: []Node{
			{Kind: Head, Value: rat("3")},
			{Kind: Injection, Value: rat("0")}, // isolated, unanchored
		},
	}
	sol, err := Solve(net)
	if err != nil {
		t.Fatal(err)
	}
	eqRat(t, sol.Pressures[0], "3")
	if len(sol.NullSpace) != 1 {
		t.Fatalf("isolated injection node is an unanchored component, got %d vectors", len(sol.NullSpace))
	}
	eqRat(t, sol.NullSpace[0][0], "0")
	eqRat(t, sol.NullSpace[0][1], "1")
	if rep := Check(net, sol); !rep.OK() {
		t.Fatalf("checker rejected valid solution: %+v", rep.Violations)
	}
}

func TestEightNodeCube(t *testing.T) {
	// Cube graph, unit resistances, one head anchor, balanced
	// injections elsewhere.
	nodes := []Node{{Kind: Head, Value: rat("0")}}
	for i := 1; i < 8; i++ {
		nodes = append(nodes, Node{Kind: Injection, Value: rat("0")})
	}
	nodes[7].Value = rat("-3")
	nodes[3].Value = rat("3")
	var edges []Edge
	for i := 0; i < 8; i++ {
		for _, bit := range []int{1, 2, 4} {
			j := i ^ bit
			if i < j {
				edges = append(edges, Edge{U: i, V: j, R: rat("1")})
			}
		}
	}
	net := &Network{Nodes: nodes, Edges: edges}
	sol, err := Solve(net)
	if err != nil {
		t.Fatal(err)
	}
	if len(sol.NullSpace) != 0 {
		t.Fatalf("anchored cube must have empty null space")
	}
	if rep := Check(net, sol); !rep.OK() {
		t.Fatalf("checker rejected valid solution: %+v", rep.Violations)
	}
	// Symmetry: only node 3 injects and only node 7 withdraws, so the
	// head node 0 must supply the balance: injection at 0 is 0? No —
	// injections sum to 0 already (3 and -3), so head residual is 0.
	eqRat(t, sol.Injections[0], "0")
}

func TestValidation(t *testing.T) {
	tooMany := &Network{Nodes: make([]Node, MaxNodes+1)}
	for i := range tooMany.Nodes {
		tooMany.Nodes[i] = Node{Kind: Head, Value: rat("0")}
	}
	if _, err := Solve(tooMany); err == nil {
		t.Fatal("want error for >8 nodes")
	}
	badR := &Network{
		Nodes: []Node{{Kind: Head, Value: rat("0")}, {Kind: Injection, Value: rat("0")}},
		Edges: []Edge{{U: 0, V: 1, R: rat("0")}},
	}
	if _, err := Solve(badR); err == nil {
		t.Fatal("want error for zero resistance")
	}
	nilVal := &Network{Nodes: []Node{{Kind: Head}}}
	if _, err := Solve(nilVal); err == nil {
		t.Fatal("want error for nil boundary value")
	}
}
