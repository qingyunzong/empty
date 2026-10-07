package solver

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.0", "1.0.1", -1},
		{"2.0", "10.0", -1},
		{"1.2", "1.2.0", -1},
		{"1.10.0", "1.9.9", 1},
		{"1.0-rc1", "1.0", -1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestRangeSatisfied(t *testing.T) {
	cases := []struct {
		rng, ver string
		want     bool
	}{
		{"*", "1.0.0", true},
		{"", "9.9", true},
		{">=1.0.0 <2.0.0", "1.5.0", true},
		{">=1.0.0,<2.0.0", "2.0.0", false},
		{"1.2.3", "1.2.3", true},
		{"1.2.3", "1.2.4", false},
		{"!=1.0.0", "1.0.0", false},
		{">0.9 <=2.0", "2.0", true},
	}
	for _, c := range cases {
		r, err := ParseRange(c.rng)
		if err != nil {
			t.Fatalf("ParseRange(%q): %v", c.rng, err)
		}
		if got := r.Satisfied(c.ver); got != c.want {
			t.Errorf("range %q satisfied by %q = %v, want %v", c.rng, c.ver, got, c.want)
		}
	}
}

func pkgs(spec map[string][]string) []Package {
	var out []Package
	for name, vs := range spec {
		out = append(out, Package{Name: name, Versions: vs})
	}
	return out
}

func TestSolveBasicFeasible(t *testing.T) {
	in := &Input{
		Packages: pkgs(map[string][]string{
			"a": {"1.0.0", "2.0.0"},
			"b": {"1.0.0", "1.5.0"},
		}),
		Dependencies: []Dependency{
			{From: "a", FromVersion: "2.0.0", To: "b", Range: ">=1.2.0"},
		},
		Roots: []Root{{Name: "a", Range: ">=1.0.0"}},
		Lock:  map[string]string{},
	}
	asgn, ok := Solve(in)
	if !ok {
		t.Fatal("expected feasible")
	}
	// Highest versions preferred: a@2.0.0 forces b>=1.2.0 -> b@1.5.0.
	want := Assignment{"a": "2.0.0", "b": "1.5.0"}
	if !reflect.DeepEqual(asgn, want) {
		t.Errorf("got %v want %v", asgn, want)
	}
	if err := Verify(in, asgn); err != nil {
		t.Errorf("certificate invalid: %v", err)
	}
}

func TestSolvePrefersFewerLockChanges(t *testing.T) {
	in := &Input{
		Packages: pkgs(map[string][]string{
			"a": {"1.0.0", "2.0.0"},
			"b": {"1.0.0", "2.0.0"},
		}),
		Lock: map[string]string{"a": "1.0.0", "b": "1.0.0"},
	}
	asgn, ok := Solve(in)
	if !ok {
		t.Fatal("expected feasible")
	}
	// Zero changes beats higher versions.
	want := Assignment{"a": "1.0.0", "b": "1.0.0"}
	if !reflect.DeepEqual(asgn, want) {
		t.Errorf("got %v want %v", asgn, want)
	}
}

func TestSolveLockChangeOnlyWhenForced(t *testing.T) {
	in := &Input{
		Packages: pkgs(map[string][]string{
			"a": {"1.0.0", "2.0.0"},
			"b": {"1.0.0", "2.0.0"},
		}),
		Conflicts: []Conflict{
			{Package: "a", Version: "1.0.0", With: "b", WithRange: "*"},
		},
		Roots: []Root{{Name: "b", Range: ">=1.0.0"}},
		Lock:  map[string]string{"a": "1.0.0", "b": "1.0.0"},
	}
	asgn, ok := Solve(in)
	if !ok {
		t.Fatal("expected feasible")
	}
	// a@1.0.0 conflicts with any b, and b is required: a must move to 2.0.0.
	// b stays at its locked version (1 change total, not 2).
	want := Assignment{"a": "2.0.0", "b": "1.0.0"}
	if !reflect.DeepEqual(asgn, want) {
		t.Errorf("got %v want %v", asgn, want)
	}
}

func TestSolveInfeasibleAndMUS(t *testing.T) {
	in := &Input{
		Packages: pkgs(map[string][]string{
			"a": {"1.0.0"},
			"b": {"1.0.0"},
			"c": {"1.0.0", "2.0.0"},
		}),
		Dependencies: []Dependency{
			{From: "a", FromVersion: "1.0.0", To: "c", Range: ">=2.0.0"},
			{From: "b", FromVersion: "1.0.0", To: "c", Range: "<2.0.0"},
		},
		Roots: []Root{{Name: "c", Range: "*"}},
	}
	if _, ok := Solve(in); ok {
		t.Fatal("expected infeasible")
	}
	set, err := MinimalConflict(in)
	if err != nil {
		t.Fatalf("MinimalConflict: %v", err)
	}
	want := []string{
		"dep a@1.0.0 -> c@>=2.0.0",
		"dep b@1.0.0 -> c@<2.0.0",
	}
	if !reflect.DeepEqual(set.Constraints, want) {
		t.Errorf("MUS = %v, want %v", set.Constraints, want)
	}
}

func TestMUSMinimality(t *testing.T) {
	// Diamond conflict with one irrelevant constraint that must be dropped.
	in := &Input{
		Packages: pkgs(map[string][]string{
			"a": {"1.0.0", "2.0.0"},
			"b": {"1.0.0"},
		}),
		Roots: []Root{
			{Name: "a", Range: ">=2.0.0"},
			{Name: "a", Range: "<2.0.0"},
			{Name: "b", Range: ">=1.0.0"}, // irrelevant, satisfiable
		},
	}
	set, err := MinimalConflict(in)
	if err != nil {
		t.Fatalf("MinimalConflict: %v", err)
	}
	if len(set.Constraints) != 2 {
		t.Errorf("MUS = %v, want exactly the two contradictory roots", set.Constraints)
	}
}

// randomInstance builds a random small instance within brute-force reach.
func randomInstance(rng *rand.Rand) *Input {
	nPkg := 2 + rng.Intn(4) // 2..5 packages
	in := &Input{Lock: map[string]string{}}
	names := []string{"a", "b", "c", "d", "e"}[:nPkg]
	for _, n := range names {
		nv := 1 + rng.Intn(3) // 1..3 versions
		vs := make([]string, nv)
		for i := range vs {
			vs[i] = "1.0." + string(rune('0'+i))
		}
		in.Packages = append(in.Packages, Package{Name: n, Versions: vs})
	}
	ranges := []string{"*", ">=1.0.1", "<1.0.2", "1.0.0", "!=1.0.1"}
	for i := 0; i < rng.Intn(5); i++ {
		from := names[rng.Intn(nPkg)]
		to := names[rng.Intn(nPkg)]
		fv := in.Packages[indexOf(names, from)].Versions[rng.Intn(len(in.Packages[indexOf(names, from)].Versions))]
		in.Dependencies = append(in.Dependencies, Dependency{
			From: from, FromVersion: fv, To: to, Range: ranges[rng.Intn(len(ranges))],
		})
	}
	for i := 0; i < rng.Intn(3); i++ {
		p := names[rng.Intn(nPkg)]
		w := names[rng.Intn(nPkg)]
		pv := in.Packages[indexOf(names, p)].Versions[rng.Intn(len(in.Packages[indexOf(names, p)].Versions))]
		in.Conflicts = append(in.Conflicts, Conflict{
			Package: p, Version: pv, With: w, WithRange: ranges[rng.Intn(len(ranges))],
		})
	}
	for i := 0; i < rng.Intn(2); i++ {
		in.Roots = append(in.Roots, Root{Name: names[rng.Intn(nPkg)], Range: ranges[rng.Intn(len(ranges))]})
	}
	for _, n := range names {
		if rng.Intn(2) == 0 {
			vs := in.Packages[indexOf(names, n)].Versions
			in.Lock[n] = vs[rng.Intn(len(vs))]
		}
	}
	return in
}

func indexOf(ss []string, s string) int {
	for i, x := range ss {
		if x == s {
			return i
		}
	}
	return -1
}

// TestSolveMatchesBruteForce cross-checks the branch-and-bound solver
// against exhaustive enumeration on many random small instances.
func TestSolveMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 500; trial++ {
		in := randomInstance(rng)
		if err := in.Validate(); err != nil {
			t.Fatalf("trial %d: invalid generated instance: %v", trial, err)
		}
		asgn, ok := Solve(in)
		br, err := BruteForce(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if ok != br.Feasible {
			t.Fatalf("trial %d: solver feasible=%v, brute=%v\ninput: %+v", trial, ok, br.Feasible, in)
		}
		if !ok {
			continue
		}
		if !reflect.DeepEqual(asgn, br.Best) {
			t.Fatalf("trial %d: solver=%v brute=%v\ninput: %+v", trial, asgn, br.Best, in)
		}
		if err := Verify(in, asgn); err != nil {
			t.Fatalf("trial %d: certificate invalid: %v", trial, err)
		}
	}
}

// TestMUSOnRandomInstances checks that every reported MUS is unsatisfiable
// and deletion-minimal, verified by brute force.
func TestMUSOnRandomInstances(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	checked := 0
	for trial := 0; trial < 2000 && checked < 50; trial++ {
		in := randomInstance(rng)
		if _, ok := Solve(in); ok {
			continue
		}
		checked++
		set, err := MinimalConflict(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if len(set.Constraints) == 0 {
			t.Fatalf("trial %d: empty MUS on infeasible instance", trial)
		}
		// Rebuild the instance restricted to the MUS and confirm via brute
		// force that it is unsatisfiable and deletion-minimal.
		sub := subsetInput(in, set.Constraints)
		br, err := BruteForce(sub)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if br.Feasible {
			t.Fatalf("trial %d: MUS is satisfiable: %v", trial, set.Constraints)
		}
		for i := range set.Constraints {
			rest := append([]string(nil), set.Constraints[:i]...)
			rest = append(rest, set.Constraints[i+1:]...)
			br, err := BruteForce(subsetInput(in, rest))
			if err != nil {
				t.Fatalf("trial %d: %v", trial, err)
			}
			if !br.Feasible {
				t.Fatalf("trial %d: MUS not minimal, %v still unsat without %q", trial, rest, set.Constraints[i])
			}
		}
	}
	if checked == 0 {
		t.Skip("no infeasible random instances generated")
	}
}

// subsetInput filters constraints by their Desc strings.
func subsetInput(in *Input, descs []string) *Input {
	want := map[string]bool{}
	for _, d := range descs {
		want[d] = true
	}
	sub := &Input{Packages: in.Packages, Lock: in.Lock}
	for _, r := range in.Roots {
		rng, _ := ParseRange(r.Range)
		if want["root "+r.Name+"@"+rng.String()] {
			sub.Roots = append(sub.Roots, r)
		}
	}
	for _, d := range in.Dependencies {
		rng, _ := ParseRange(d.Range)
		if want["dep "+d.From+"@"+d.FromVersion+" -> "+d.To+"@"+rng.String()] {
			sub.Dependencies = append(sub.Dependencies, d)
		}
	}
	for _, c := range in.Conflicts {
		rng, _ := ParseRange(c.WithRange)
		if want["conflict "+c.Package+"@"+c.Version+" !! "+c.With+"@"+rng.String()] {
			sub.Conflicts = append(sub.Conflicts, c)
		}
	}
	return sub
}

func TestValidateLimits(t *testing.T) {
	in := &Input{Packages: pkgs(map[string][]string{"a": {"1.0.0"}})}
	if err := in.Validate(); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	big := &Input{}
	for i := 0; i < MaxPackages+1; i++ {
		big.Packages = append(big.Packages, Package{Name: string(rune('a' + i)), Versions: []string{"1.0.0"}})
	}
	if err := big.Validate(); err == nil {
		t.Error("expected error for >16 packages")
	}
	many := &Input{Packages: []Package{{Name: "a", Versions: []string{"1", "2", "3", "4", "5"}}}}
	if err := many.Validate(); err == nil {
		t.Error("expected error for >4 versions")
	}
}
