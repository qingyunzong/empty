package solver

import (
	"math/rand"
	"testing"
)

func TestParseVersionAndCompare(t *testing.T) {
	v, err := ParseVersion("1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Parts) != 3 || v.Parts[0] != 1 || v.Parts[2] != 3 {
		t.Fatalf("bad parse: %+v", v)
	}
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0},
		{"1.2", "1.2.0", 0},
		{"2.0.0", "10.0.0", -1},
		{"1.10.0", "1.9.9", 1},
		{"0.9", "1.0", -1},
	}
	for _, c := range cases {
		a, _ := ParseVersion(c.a)
		b, _ := ParseVersion(c.b)
		if got := CompareVersion(a, b); got != c.want {
			t.Errorf("CompareVersion(%s,%s)=%d want %d", c.a, c.b, got, c.want)
		}
	}
	if _, err := ParseVersion("1.x"); err == nil {
		t.Error("expected error for 1.x")
	}
}

func TestRangeMatches(t *testing.T) {
	cases := []struct {
		rng  string
		ver  string
		want bool
	}{
		{"*", "1.2.3", true},
		{"", "0.0.1", true},
		{">=1.0.0", "1.0.0", true},
		{">=1.0.0 <2.0.0", "1.9.9", true},
		{">=1.0.0, <2.0.0", "2.0.0", false},
		{"=1.4.0", "1.4.0", true},
		{"1.4.0", "1.4", true},
		{"!=1.0.0", "1.0.0", false},
		{">1.0.0 <=2.0.0", "2.0.0", true},
		{"<1.0.0", "0.9.9", true},
	}
	for _, c := range cases {
		r, err := ParseRange(c.rng)
		if err != nil {
			t.Fatalf("ParseRange(%q): %v", c.rng, err)
		}
		v, _ := ParseVersion(c.ver)
		if got := r.Matches(v); got != c.want {
			t.Errorf("range %q vs %s = %v, want %v", c.rng, c.ver, got, c.want)
		}
	}
	if _, err := ParseRange(">=x"); err == nil {
		t.Error("expected error for >=x")
	}
}

func chainInstance() *Instance {
	return &Instance{
		Packages: []Package{
			{Name: "app", Versions: []VersionSpec{
				{Version: "1.0.0", Depends: []Dep{{Name: "lib", Range: ">=1.0.0 <2.0.0"}}},
				{Version: "2.0.0", Depends: []Dep{{Name: "lib", Range: ">=2.0.0"}}},
			}},
			{Name: "lib", Versions: []VersionSpec{
				{Version: "1.0.0"},
				{Version: "2.0.0", Depends: []Dep{{Name: "util", Range: ">=1.1.0"}}},
			}},
			{Name: "util", Versions: []VersionSpec{
				{Version: "1.0.0"},
				{Version: "1.1.0"},
			}},
		},
		Roots: []Dep{{Name: "app", Range: ">=1.0.0"}},
	}
}

func TestFeasibleBasic(t *testing.T) {
	inst := chainInstance()
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "feasible" {
		t.Fatalf("status=%s conflict=%v", res.Status, res.Conflict)
	}
	if err := Verify(inst, res.Solution); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
	// Empty lock: every install is a change, so the minimal install set
	// wins (app@1.0.0 + lib@1.0.0 = 2 changes; util not needed).
	want := map[string]string{"app": "1.0.0", "lib": "1.0.0"}
	if res.Changes != 2 {
		t.Errorf("changes=%d, want 2", res.Changes)
	}
	if len(res.Solution) != len(want) {
		t.Errorf("solution=%v, want %v", res.Solution, want)
	}
	for k, v := range want {
		if res.Solution[k] != v {
			t.Errorf("solution[%s]=%s want %s (full: %v)", k, res.Solution[k], v, res.Solution)
		}
	}
	if err := CrossCheck(inst); err != nil {
		t.Fatal(err)
	}
}

func TestPreferHigherVersions(t *testing.T) {
	// Both roots must be installed, so the change count is fixed and the
	// version tie-break decides: highest versions win.
	inst := &Instance{
		Packages: []Package{
			{Name: "a", Versions: []VersionSpec{{Version: "1.0.0"}, {Version: "2.0.0"}}},
			{Name: "b", Versions: []VersionSpec{{Version: "1.0.0"}, {Version: "1.5.0"}}},
		},
		Roots: []Dep{{Name: "a", Range: "*"}, {Name: "b", Range: "*"}},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "feasible" {
		t.Fatalf("status=%s conflict=%v", res.Status, res.Conflict)
	}
	if res.Changes != 2 {
		t.Errorf("changes=%d, want 2", res.Changes)
	}
	if res.Solution["a"] != "2.0.0" || res.Solution["b"] != "1.5.0" {
		t.Errorf("solution=%v, want a=2.0.0 b=1.5.0", res.Solution)
	}
	if err := CrossCheck(inst); err != nil {
		t.Fatal(err)
	}
}

func TestLockPreference(t *testing.T) {
	inst := chainInstance()
	inst.Lock = map[string]string{"app": "1.0.0", "lib": "1.0.0", "util": "1.0.0"}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "feasible" {
		t.Fatalf("status=%s conflict=%v", res.Status, res.Conflict)
	}
	if res.Changes != 0 {
		t.Fatalf("changes=%d, want 0 (solution %v)", res.Changes, res.Solution)
	}
	for k, v := range inst.Lock {
		if res.Solution[k] != v {
			t.Errorf("solution[%s]=%s want locked %s", k, res.Solution[k], v)
		}
	}
	if err := CrossCheck(inst); err != nil {
		t.Fatal(err)
	}
}

func TestLockMinimalChanges(t *testing.T) {
	inst := chainInstance()
	// Lock is infeasible as-is: app@1.0.0 needs lib<2 but lib locked at 2.0.0.
	inst.Lock = map[string]string{"app": "1.0.0", "lib": "2.0.0", "util": "1.1.0"}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "feasible" {
		t.Fatalf("status=%s conflict=%v", res.Status, res.Conflict)
	}
	if res.Changes != 1 {
		t.Fatalf("changes=%d, want 1 (solution %v)", res.Changes, res.Solution)
	}
	if err := CrossCheck(inst); err != nil {
		t.Fatal(err)
	}
}

func TestMutualExclusion(t *testing.T) {
	inst := &Instance{
		Packages: []Package{
			{Name: "a", Versions: []VersionSpec{
				{Version: "1.0.0", Conflicts: []Dep{{Name: "b", Range: "*"}}},
			}},
			{Name: "b", Versions: []VersionSpec{
				{Version: "1.0.0"},
			}},
		},
		Roots: []Dep{{Name: "a", Range: "*"}},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "feasible" {
		t.Fatalf("status=%s", res.Status)
	}
	if _, ok := res.Solution["b"]; ok {
		t.Errorf("b must not be installed: %v", res.Solution)
	}
	// Now require both -> infeasible.
	inst.Roots = append(inst.Roots, Dep{Name: "b", Range: "*"})
	res, err = Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "infeasible" {
		t.Fatalf("status=%s, want infeasible", res.Status)
	}
	if len(res.Conflict) == 0 {
		t.Fatal("expected conflict core")
	}
	if err := CrossCheck(inst); err != nil {
		t.Fatal(err)
	}
}

func TestInfeasibleCoreMinimal(t *testing.T) {
	inst := &Instance{
		Packages: []Package{
			{Name: "a", Versions: []VersionSpec{
				{Version: "1.0.0", Depends: []Dep{{Name: "b", Range: ">=2.0.0"}}},
			}},
			{Name: "b", Versions: []VersionSpec{{Version: "1.0.0"}}},
			{Name: "c", Versions: []VersionSpec{{Version: "1.0.0"}}},
		},
		Roots: []Dep{
			{Name: "a", Range: "*"},
			{Name: "c", Range: "*"}, // irrelevant, must not appear in core
		},
	}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "infeasible" {
		t.Fatalf("status=%s", res.Status)
	}
	if len(res.Conflict) != 2 {
		t.Fatalf("core=%v, want exactly 2 constraints", res.Conflict)
	}
	for _, d := range res.Conflict {
		if d == "root: c *" {
			t.Errorf("irrelevant constraint in core: %v", res.Conflict)
		}
	}
	if err := CrossCheck(inst); err != nil {
		t.Fatal(err)
	}
}

func TestLimits(t *testing.T) {
	inst := &Instance{Roots: []Dep{{Name: "p0", Range: "*"}}}
	for i := 0; i < MaxPackages+1; i++ {
		name := "p" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		inst.Packages = append(inst.Packages, Package{Name: name, Versions: []VersionSpec{{Version: "1.0.0"}}})
	}
	if _, err := Solve(inst); err == nil {
		t.Error("expected error for >16 packages")
	}
	inst = &Instance{
		Packages: []Package{{Name: "a", Versions: []VersionSpec{
			{Version: "1.0.0"}, {Version: "1.1.0"}, {Version: "1.2.0"}, {Version: "1.3.0"}, {Version: "1.4.0"},
		}}},
		Roots: []Dep{{Name: "a", Range: "*"}},
	}
	if _, err := Solve(inst); err == nil {
		t.Error("expected error for >4 versions")
	}
}

func TestMaxSizeInstance(t *testing.T) {
	// 16 packages x 4 versions chain; must solve quickly.
	inst := &Instance{}
	for i := 0; i < MaxPackages; i++ {
		name := "pkg" + string(rune('A'+i))
		p := Package{Name: name}
		for v := 0; v < MaxVersions; v++ {
			vs := VersionSpec{Version: "1." + string(rune('0'+v)) + ".0"}
			if i+1 < MaxPackages {
				vs.Depends = []Dep{{Name: "pkg" + string(rune('A'+i+1)), Range: ">=1.1.0"}}
			}
			p.Versions = append(p.Versions, vs)
		}
		inst.Packages = append(inst.Packages, p)
	}
	inst.Roots = []Dep{{Name: "pkgA", Range: "*"}}
	res, err := Solve(inst)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "feasible" {
		t.Fatalf("status=%s conflict=%v", res.Status, res.Conflict)
	}
	if len(res.Solution) != MaxPackages {
		t.Fatalf("solution has %d packages, want %d", len(res.Solution), MaxPackages)
	}
	if err := Verify(inst, res.Solution); err != nil {
		t.Fatal(err)
	}
}

var rangeTemplates = []string{
	"*", ">=1.0.0", ">=1.1.0", "<2.0.0", ">=1.0.0 <2.0.0",
	"=1.0.0", "=1.1.0", "!=1.0.0", ">0.9.0", ">=3.0.0",
}

func randomInstance(r *rand.Rand) *Instance {
	n := 2 + r.Intn(4) // 2..5 packages
	versionPool := []string{"1.0.0", "1.1.0", "2.0.0"}
	inst := &Instance{}
	for i := 0; i < n; i++ {
		name := "p" + string(rune('a'+i))
		p := Package{Name: name}
		nv := 1 + r.Intn(3) // 1..3 versions
		for v := 0; v < nv; v++ {
			vs := VersionSpec{Version: versionPool[v]}
			for d := 0; d < r.Intn(3); d++ {
				vs.Depends = append(vs.Depends, Dep{
					Name:  "p" + string(rune('a'+r.Intn(n))),
					Range: rangeTemplates[r.Intn(len(rangeTemplates))],
				})
			}
			if r.Intn(3) == 0 {
				vs.Conflicts = []Dep{{
					Name:  "p" + string(rune('a'+r.Intn(n))),
					Range: rangeTemplates[r.Intn(len(rangeTemplates))],
				}}
			}
			p.Versions = append(p.Versions, vs)
		}
		inst.Packages = append(inst.Packages, p)
	}
	for i := 0; i < 1+r.Intn(2); i++ {
		inst.Roots = append(inst.Roots, Dep{
			Name:  "p" + string(rune('a'+r.Intn(n))),
			Range: rangeTemplates[r.Intn(len(rangeTemplates))],
		})
	}
	inst.Lock = make(map[string]string)
	for _, p := range inst.Packages {
		if r.Intn(2) == 0 {
			if r.Intn(4) == 0 {
				inst.Lock[p.Name] = "9.9.9" // unavailable version
			} else {
				inst.Lock[p.Name] = p.Versions[r.Intn(len(p.Versions))].Version
			}
		}
	}
	return inst
}

func TestRandomCrossCheck(t *testing.T) {
	r := rand.New(rand.NewSource(20261005))
	feasible, infeasible := 0, 0
	for i := 0; i < 300; i++ {
		inst := randomInstance(r)
		if err := CrossCheck(inst); err != nil {
			t.Fatalf("instance %d: %v\ninstance: %+v", i, err, inst)
		}
		res, err := Solve(inst)
		if err != nil {
			t.Fatalf("instance %d: %v", i, err)
		}
		if res.Status == "feasible" {
			feasible++
			if err := Verify(inst, res.Solution); err != nil {
				t.Fatalf("instance %d: bad certificate: %v", i, err)
			}
		} else {
			infeasible++
		}
	}
	t.Logf("feasible=%d infeasible=%d", feasible, infeasible)
	if feasible == 0 || infeasible == 0 {
		t.Errorf("random generator lopsided: feasible=%d infeasible=%d", feasible, infeasible)
	}
}
