package pipenet

import (
	"math/big"
	"strings"
	"testing"
)

func solvedNet(t *testing.T) (*Network, *Solution) {
	t.Helper()
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
	return net, sol
}

func cloneSol(sol *Solution) *Solution {
	cp := &Solution{
		Pressures:  make([]*big.Rat, len(sol.Pressures)),
		Flows:      make([]*big.Rat, len(sol.Flows)),
		Injections: make([]*big.Rat, len(sol.Injections)),
		NullSpace:  make([][]*big.Rat, len(sol.NullSpace)),
	}
	for i, x := range sol.Pressures {
		cp.Pressures[i] = new(big.Rat).Set(x)
	}
	for i, x := range sol.Flows {
		cp.Flows[i] = new(big.Rat).Set(x)
	}
	for i, x := range sol.Injections {
		cp.Injections[i] = new(big.Rat).Set(x)
	}
	for k, v := range sol.NullSpace {
		cp.NullSpace[k] = make([]*big.Rat, len(v))
		for i, x := range v {
			cp.NullSpace[k][i] = new(big.Rat).Set(x)
		}
	}
	return cp
}

func hasViolation(rep *Report, substr string) bool {
	for _, v := range rep.Violations {
		if strings.Contains(v.Equation, substr) {
			return true
		}
	}
	return false
}

func TestCheckerAcceptsExactSolution(t *testing.T) {
	net, sol := solvedNet(t)
	if rep := Check(net, sol); !rep.OK() {
		t.Fatalf("unexpected violations: %+v", rep.Violations)
	}
}

func TestCheckerRejectsPerturbedFlow(t *testing.T) {
	net, sol := solvedNet(t)
	bad := cloneSol(sol)
	bad.Flows[0].Add(bad.Flows[0], rat("1/7"))
	rep := Check(net, bad)
	if rep.OK() {
		t.Fatal("checker accepted perturbed flow")
	}
	if !hasViolation(rep, "resistance: edge 0") {
		t.Fatalf("missing resistance violation: %+v", rep.Violations)
	}
	if !hasViolation(rep, "conservation") {
		t.Fatalf("missing conservation violation: %+v", rep.Violations)
	}
}

func TestCheckerRejectsPerturbedHead(t *testing.T) {
	net, sol := solvedNet(t)
	bad := cloneSol(sol)
	bad.Pressures[0].Add(bad.Pressures[0], rat("1/1000"))
	rep := Check(net, bad)
	if rep.OK() || !hasViolation(rep, "head: node 0") {
		t.Fatalf("missing head violation: %+v", rep.Violations)
	}
}

func TestCheckerRejectsBrokenNullSpaceEvidence(t *testing.T) {
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
	// Dropping the null-space vector hides the non-uniqueness.
	hidden := cloneSol(sol)
	hidden.NullSpace = nil
	if rep := Check(net, hidden); rep.OK() || !hasViolation(rep, "unanchored component") {
		t.Fatalf("missing null-space coverage violation: %+v", rep.Violations)
	}
	// A vector that is not constant across the edge is not evidence.
	wrong := cloneSol(sol)
	wrong.NullSpace[0][1] = rat("2")
	rep := Check(net, wrong)
	if rep.OK() || !hasViolation(rep, "null-space") {
		t.Fatalf("missing null-space validity violation: %+v", rep.Violations)
	}
}

func TestCheckerRejectsSpuriousNullVector(t *testing.T) {
	net, sol := solvedNet(t)
	bad := cloneSol(sol)
	bad.NullSpace = [][]*big.Rat{rats("1", "1", "1")}
	if rep := Check(net, bad); rep.OK() || !hasViolation(rep, "spurious") {
		t.Fatalf("missing spurious-vector violation: %+v", rep.Violations)
	}
}
