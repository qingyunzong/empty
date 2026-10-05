package licchk

import (
	"errors"
	"math/rand"
	"testing"
)

func mustExpr(t *testing.T, src string) Expr {
	t.Helper()
	e, err := ParseExpr(src)
	if err != nil {
		t.Fatalf("ParseExpr(%q): %v", src, err)
	}
	return e
}

func TestSolveNoExceptions(t *testing.T) {
	p := Problem{
		Packages: map[string]Expr{
			"app":  mustExpr(t, "MIT"),
			"liba": mustExpr(t, "MIT OR Apache-2.0"),
			"libb": mustExpr(t, "BSD-3-Clause"),
		},
		Graph: Graph{
			"app":  {"liba", "libb"},
			"liba": {"libb"},
		},
		Entry:  "app",
		Policy: Policy{Forbidden: []string{"GPL-3.0"}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 0 {
		t.Fatalf("expected 0 exceptions, got %v", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got := cert.Selected["liba"]; len(got) != 1 || got[0] != "MIT" {
		t.Fatalf("liba selection = %v, want [MIT]", got)
	}
}

func TestSolveForcedException(t *testing.T) {
	// "bad" only offers GPL-3.0, which is forbidden: it must be an
	// exception. The rest can be satisfied.
	p := Problem{
		Packages: map[string]Expr{
			"app": mustExpr(t, "MIT"),
			"ok":  mustExpr(t, "Apache-2.0 OR MIT"),
			"bad": mustExpr(t, "GPL-3.0"),
		},
		Graph:  Graph{"app": {"ok", "bad"}},
		Entry:  "app",
		Policy: Policy{Forbidden: []string{"GPL-3.0"}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 1 || cert.Exceptions[0] != "bad" {
		t.Fatalf("exceptions = %v, want [bad]", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveIncompatiblePair(t *testing.T) {
	// a and b can each pick MIT or GPL-2.0, but MIT and GPL-2.0 may not
	// co-occur. Both can pick MIT: zero exceptions.
	p := Problem{
		Packages: map[string]Expr{
			"a": mustExpr(t, "MIT OR GPL-2.0"),
			"b": mustExpr(t, "GPL-2.0 OR MIT"),
		},
		Graph:  Graph{"a": {"b"}},
		Entry:  "a",
		Policy: Policy{Incompatible: [][2]string{{"MIT", "GPL-2.0"}}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 0 {
		t.Fatalf("exceptions = %v, want none", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveIncompatibleForcedException(t *testing.T) {
	// a is fixed to MIT, b is fixed to GPL-2.0, and the two are
	// incompatible: one exception is unavoidable.
	p := Problem{
		Packages: map[string]Expr{
			"a": mustExpr(t, "MIT"),
			"b": mustExpr(t, "GPL-2.0"),
		},
		Graph:  Graph{"a": {"b"}},
		Entry:  "a",
		Policy: Policy{Incompatible: [][2]string{{"MIT", "GPL-2.0"}}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 1 {
		t.Fatalf("exceptions = %v, want exactly 1", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveSelfConflictingAnd(t *testing.T) {
	// "weird" requires MIT AND GPL-2.0 simultaneously, which is an
	// incompatible pair: it must be an exception.
	p := Problem{
		Packages: map[string]Expr{
			"app":   mustExpr(t, "MIT"),
			"weird": mustExpr(t, "MIT AND GPL-2.0"),
		},
		Graph:  Graph{"app": {"weird"}},
		Entry:  "app",
		Policy: Policy{Incompatible: [][2]string{{"MIT", "GPL-2.0"}}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 1 || cert.Exceptions[0] != "weird" {
		t.Fatalf("exceptions = %v, want [weird]", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveCyclicGraph(t *testing.T) {
	// The cycle a -> b -> c -> a must not hang the solver, and the
	// certificate must cover exactly the reachable set.
	p := Problem{
		Packages: map[string]Expr{
			"a": mustExpr(t, "MIT"),
			"b": mustExpr(t, "Apache-2.0"),
			"c": mustExpr(t, "BSD-3-Clause OR MIT"),
		},
		Graph: Graph{
			"a": {"b"},
			"b": {"c"},
			"c": {"a"},
		},
		Entry:  "a",
		Policy: Policy{Forbidden: []string{"GPL-3.0"}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 0 {
		t.Fatalf("exceptions = %v, want none", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveUnreachableViolatorNotReported(t *testing.T) {
	// "evil" is unreachable from "app" and only offers a forbidden
	// license. It must not appear anywhere in the certificate.
	p := Problem{
		Packages: map[string]Expr{
			"app":  mustExpr(t, "MIT"),
			"ok":   mustExpr(t, "Apache-2.0"),
			"evil": mustExpr(t, "GPL-3.0"),
		},
		Graph:  Graph{"app": {"ok"}, "evil": {"app"}},
		Entry:  "app",
		Policy: Policy{Forbidden: []string{"GPL-3.0"}},
	}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.NumExceptions() != 0 {
		t.Fatalf("exceptions = %v, want none (unreachable violator must not be reported)", cert.Exceptions)
	}
	for _, name := range cert.Reachable {
		if name == "evil" {
			t.Fatalf("unreachable package reported as reachable")
		}
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveTooManyPackages(t *testing.T) {
	pkgs := map[string]Expr{}
	g := Graph{}
	for i := 0; i < MaxPackages+1; i++ {
		name := pkgName(i)
		pkgs[name] = mustExpr(t, "MIT")
		if i > 0 {
			g[pkgName(i-1)] = []string{name}
		}
	}
	p := Problem{Packages: pkgs, Graph: g, Entry: pkgName(0)}
	if _, err := Solve(p); !errors.Is(err, ErrTooManyPackages) {
		t.Fatalf("expected ErrTooManyPackages, got %v", err)
	}
}

func pkgName(i int) string {
	return "pkg-" + string(rune('A'+i/26)) + string(rune('A'+i%26))
}

func TestSolveMaxPackagesOK(t *testing.T) {
	pkgs := map[string]Expr{}
	g := Graph{}
	for i := 0; i < MaxPackages; i++ {
		name := pkgName(i)
		pkgs[name] = mustExpr(t, "MIT OR Apache-2.0")
		if i > 0 {
			g[pkgName(i-1)] = []string{name}
		}
	}
	p := Problem{Packages: pkgs, Graph: g, Entry: pkgName(0), Policy: Policy{Forbidden: []string{"GPL-3.0"}}}
	cert, err := Solve(p)
	if err != nil {
		t.Fatalf("Solve with %d packages: %v", MaxPackages, err)
	}
	if cert.NumExceptions() != 0 {
		t.Fatalf("exceptions = %v, want none", cert.Exceptions)
	}
	if err := cert.Verify(p); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestSolveMissingExpression(t *testing.T) {
	p := Problem{
		Packages: map[string]Expr{"app": mustExpr(t, "MIT")},
		Graph:    Graph{"app": {"ghost"}},
		Entry:    "app",
	}
	if _, err := Solve(p); err == nil {
		t.Fatalf("expected error for missing license expression")
	}
}

// TestSolveMatchesExhaustive cross-checks the branch-and-bound solver
// against a full exhaustive search on many randomized instances, including
// cyclic graphs and unreachable packages.
func TestSolveMatchesExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	licenses := []string{"MIT", "Apache-2.0", "BSD-3-Clause", "GPL-2.0", "LGPL-2.1"}
	for trial := 0; trial < 300; trial++ {
		n := 2 + rng.Intn(7) // 2..8 packages total in the universe
		names := make([]string, n)
		pkgs := map[string]Expr{}
		for i := range names {
			names[i] = pkgName(i)
			pkgs[names[i]] = randomExpr(rng, licenses)
		}
		g := Graph{}
		for _, name := range names {
			var deps []string
			for _, other := range names {
				if other != name && rng.Intn(4) == 0 {
					deps = append(deps, other)
				}
			}
			g[name] = deps
		}
		var pol Policy
		for _, lic := range licenses {
			if rng.Intn(6) == 0 {
				pol.Forbidden = append(pol.Forbidden, lic)
			}
		}
		for i := 0; i < len(licenses); i++ {
			for j := i + 1; j < len(licenses); j++ {
				if rng.Intn(5) == 0 {
					pol.Incompatible = append(pol.Incompatible, [2]string{licenses[i], licenses[j]})
				}
			}
		}
		p := Problem{Packages: pkgs, Graph: g, Entry: names[0], Policy: pol}
		cert, err := Solve(p)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		want, err := solveExhaustive(p)
		if err != nil {
			t.Fatalf("trial %d: exhaustive: %v", trial, err)
		}
		if cert.NumExceptions() != want {
			t.Fatalf("trial %d: Solve exceptions = %d, exhaustive = %d\nproblem: %+v", trial, cert.NumExceptions(), want, p)
		}
		if err := cert.Verify(p); err != nil {
			t.Fatalf("trial %d: Verify: %v", trial, err)
		}
	}
}

func randomExpr(rng *rand.Rand, licenses []string) Expr {
	leaf := func() Expr { return &Leaf{Name: licenses[rng.Intn(len(licenses))]} }
	switch rng.Intn(4) {
	case 0:
		return leaf()
	case 1:
		return &Or{L: leaf(), R: leaf()}
	case 2:
		return &And{L: leaf(), R: leaf()}
	default:
		return &And{L: &Or{L: leaf(), R: leaf()}, R: leaf()}
	}
}
