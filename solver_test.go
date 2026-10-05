package licenseselect

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestParseExprAndBranches(t *testing.T) {
	cases := []struct {
		in   string
		want []Branch
	}{
		{"MIT", []Branch{{"MIT"}}},
		{"MIT OR Apache-2.0", []Branch{{"MIT"}, {"Apache-2.0"}}},
		{"MIT AND BSD-3-Clause", []Branch{{"BSD-3-Clause", "MIT"}}},
		{"(MIT OR Apache-2.0) AND BSD-3-Clause", []Branch{{"BSD-3-Clause", "MIT"}, {"Apache-2.0", "BSD-3-Clause"}}},
		{"(MIT OR Apache-2.0) OR GPL-3.0", []Branch{{"MIT"}, {"Apache-2.0"}, {"GPL-3.0"}}},
		{"MIT OR MIT", []Branch{{"MIT"}}},
		{"(A AND B) OR (B AND A)", []Branch{{"A", "B"}}},
		{"a OR b AND c", []Branch{{"a"}, {"b", "c"}}}, // AND binds tighter
	}
	for _, tc := range cases {
		expr, err := ParseExpr(tc.in)
		if err != nil {
			t.Fatalf("ParseExpr(%q): %v", tc.in, err)
		}
		got := Branches(expr)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("Branches(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestParseExprErrors(t *testing.T) {
	for _, in := range []string{"", "MIT OR", "AND MIT", "(MIT", "MIT)", "MIT @ GPL"} {
		if _, err := ParseExpr(in); err == nil {
			t.Errorf("ParseExpr(%q) expected error, got nil", in)
		}
	}
}

func TestReachableWithCycle(t *testing.T) {
	g := &Graph{Pkgs: map[string]Package{
		"app": {Name: "app", License: "MIT", Deps: []string{"a"}},
		"a":   {Name: "a", License: "MIT", Deps: []string{"b"}},
		"b":   {Name: "b", License: "MIT", Deps: []string{"a", "app"}}, // cycle back
		"far": {Name: "far", License: "GPL-3.0"},
	}}
	got := g.Reachable("app")
	want := []string{"a", "app", "b"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Reachable = %v, want %v", got, want)
	}
}

func TestUnreachableViolationsNotReported(t *testing.T) {
	// "hidden" violates policy but is unreachable; "loop" forms a cycle.
	g := &Graph{Pkgs: map[string]Package{
		"app":    {Name: "app", License: "MIT", Deps: []string{"loop1"}},
		"loop1":  {Name: "loop1", License: "Apache-2.0", Deps: []string{"loop2"}},
		"loop2":  {Name: "loop2", License: "BSD-3-Clause", Deps: []string{"loop1"}},
		"hidden": {Name: "hidden", License: "GPL-3.0"},
	}}
	c := &Constraints{Allowed: map[string]bool{"MIT": true, "Apache-2.0": true, "BSD-3-Clause": true}}
	cert, err := Solve(g, "app", c)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.ExceptionCount() != 0 {
		t.Errorf("exceptions = %v, want none (hidden package must not be reported)", cert.Exceptions)
	}
	if _, ok := cert.Selections["hidden"]; ok {
		t.Errorf("unreachable package hidden got a selection")
	}
	if err := cert.Verify(g, "app", c); err != nil {
		t.Errorf("Verify: %v", err)
	}
}

func TestSolveChoosesCompatibleBranch(t *testing.T) {
	g := &Graph{Pkgs: map[string]Package{
		"app": {Name: "app", License: "MIT", Deps: []string{"lib"}},
		"lib": {Name: "lib", License: "GPL-3.0 OR Apache-2.0"},
	}}
	c := &Constraints{Allowed: map[string]bool{"MIT": true, "Apache-2.0": true}}
	cert, err := Solve(g, "app", c)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.ExceptionCount() != 0 {
		t.Fatalf("exceptions = %v, want none", cert.Exceptions)
	}
	if got := cert.Selections["lib"]; !reflect.DeepEqual(got, Branch{"Apache-2.0"}) {
		t.Errorf("lib branch = %v, want [Apache-2.0]", got)
	}
	if err := cert.Verify(g, "app", c); err != nil {
		t.Errorf("Verify: %v", err)
	}
}

func TestSolveMinimizesExceptions(t *testing.T) {
	// bad1 and bad2 cannot both be satisfied; exactly one exception is optimal.
	g := &Graph{Pkgs: map[string]Package{
		"app":  {Name: "app", License: "MIT", Deps: []string{"bad1", "bad2", "ok"}},
		"bad1": {Name: "bad1", License: "GPL-3.0"},
		"bad2": {Name: "bad2", License: "Proprietary"},
		"ok":   {Name: "ok", License: "MIT OR Proprietary"},
	}}
	c := &Constraints{
		Allowed:      map[string]bool{"MIT": true, "GPL-3.0": true, "Proprietary": true},
		Incompatible: [][2]string{{"GPL-3.0", "Proprietary"}},
	}
	cert, err := Solve(g, "app", c)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	// bad1 vs bad2 conflict is unavoidable -> at least 2 exceptions among
	// {bad1,bad2}; "ok" can pick MIT to stay clean.
	if cert.ExceptionCount() != 2 {
		t.Errorf("exceptions = %v, want exactly 2", cert.Exceptions)
	}
	for _, e := range cert.Exceptions {
		if e == "ok" || e == "app" {
			t.Errorf("unexpected exception %q", e)
		}
	}
	if err := cert.Verify(g, "app", c); err != nil {
		t.Errorf("Verify: %v", err)
	}
}

func TestSolvePackageLimit(t *testing.T) {
	g := &Graph{Pkgs: map[string]Package{"app": {Name: "app", License: "MIT"}}}
	prev := "app"
	for i := 0; i < MaxPackages; i++ {
		name := fmt.Sprintf("p%d", i)
		g.Pkgs[name] = Package{Name: name, License: "MIT"}
		g.Pkgs[prev] = Package{Name: prev, License: "MIT", Deps: []string{name}}
		prev = name
	}
	c := &Constraints{Allowed: map[string]bool{"MIT": true}}
	if _, err := Solve(g, "app", c); err == nil {
		t.Errorf("expected error for %d reachable packages", MaxPackages+1)
	}
	// Trim one package: exactly MaxPackages must succeed.
	g.Pkgs["app"] = Package{Name: "app", License: "MIT", Deps: []string{"p1"}}
	if _, err := Solve(g, "app", c); err != nil {
		t.Errorf("Solve with %d packages: %v", MaxPackages, err)
	}
}

func TestVerifyRejectsTamperedCertificate(t *testing.T) {
	g := &Graph{Pkgs: map[string]Package{
		"app": {Name: "app", License: "MIT", Deps: []string{"lib"}},
		"lib": {Name: "lib", License: "GPL-3.0"},
	}}
	c := &Constraints{Allowed: map[string]bool{"MIT": true}}
	cert, err := Solve(g, "app", c)
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if cert.ExceptionCount() != 1 {
		t.Fatalf("exceptions = %v, want 1", cert.Exceptions)
	}
	// Tamper: drop the exception.
	bad := &Certificate{Selections: cert.Selections}
	if err := bad.Verify(g, "app", c); err == nil {
		t.Errorf("Verify accepted certificate hiding a violation")
	}
	// Tamper: invent an invalid branch.
	bad2 := &Certificate{Selections: map[string]Branch{"app": {"MIT"}, "lib": {"MIT"}}, Exceptions: cert.Exceptions}
	if err := bad2.Verify(g, "app", c); err == nil {
		t.Errorf("Verify accepted certificate with invalid branch")
	}
}

// TestSolveMatchesExhaustive cross-checks the branch-and-bound solver against
// brute-force enumeration on randomized small graphs, including cycles and
// unreachable packages.
func TestSolveMatchesExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	licenses := []string{"MIT", "Apache-2.0", "BSD-3-Clause", "GPL-3.0", "LGPL-2.1", "Proprietary"}
	exprs := []string{
		"MIT", "Apache-2.0", "GPL-3.0", "Proprietary",
		"MIT OR Apache-2.0", "GPL-3.0 OR MIT", "LGPL-2.1 OR BSD-3-Clause",
		"(MIT OR Apache-2.0) AND BSD-3-Clause", "GPL-3.0 OR Proprietary",
	}
	for trial := 0; trial < 60; trial++ {
		n := 2 + rng.Intn(7) // 2..8 packages
		g := &Graph{Pkgs: map[string]Package{}}
		names := make([]string, n)
		for i := 0; i < n; i++ {
			names[i] = fmt.Sprintf("p%d", i)
		}
		for i := 0; i < n; i++ {
			var deps []string
			for _, d := range names {
				if d != names[i] && rng.Intn(4) == 0 { // allows cycles
					deps = append(deps, d)
				}
			}
			g.Pkgs[names[i]] = Package{Name: names[i], License: exprs[rng.Intn(len(exprs))], Deps: deps}
		}
		allowed := map[string]bool{}
		for _, l := range licenses {
			allowed[l] = rng.Intn(3) != 0
		}
		var incompat [][2]string
		for i := 0; i < len(licenses); i++ {
			for j := i + 1; j < len(licenses); j++ {
				if rng.Intn(6) == 0 {
					incompat = append(incompat, [2]string{licenses[i], licenses[j]})
				}
			}
		}
		c := &Constraints{Allowed: allowed, Incompatible: incompat}
		cert, err := Solve(g, "p0", c)
		if err != nil {
			t.Fatalf("trial %d: Solve: %v", trial, err)
		}
		if err := cert.Verify(g, "p0", c); err != nil {
			t.Fatalf("trial %d: Verify: %v", trial, err)
		}
		want, err := ExhaustiveMinExceptions(g, "p0", c)
		if err != nil {
			t.Fatalf("trial %d: Exhaustive: %v", trial, err)
		}
		if cert.ExceptionCount() != want {
			t.Errorf("trial %d: solver exceptions = %d, exhaustive optimum = %d", trial, cert.ExceptionCount(), want)
		}
	}
}
