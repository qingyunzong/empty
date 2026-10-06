package linearchk

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, src string) []Cmd {
	t.Helper()
	prog, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return prog
}

func TestValidPrograms(t *testing.T) {
	cases := map[string]string{
		"shared borrows coexist": `
			new x
			share r = &x
			share m = &x
			use x
			use r
			use m
			drop r
			drop m
			drop x`,
		"exclusive borrow alone": `
			new x
			excl m = &mut x
			use m
			mut m
			drop m
			mut x
			drop x`,
		"borrow transfer": `
			new x
			share r = &x
			move m = r
			use m
			drop m
			drop x`,
		"owner transfer": `
			new x
			move y = x
			use y
			drop y`,
		"branch merge compatible": `
			new x
			if { share r = &x drop r } else { }
			mut x
			drop x`,
		"both branches borrow alike": `
			new x
			if { share r = &x } else { share r = &x }
			use r
			drop r
			drop x`,
		"exclusive borrow transferred": `
			new x
			excl m = &mut x
			move q = m
			mut q
			drop q
			drop x`,
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			prog := mustParse(t, src)
			if vs := Check(prog); len(vs) != 0 {
				t.Fatalf("expected no violations, got %v", vs)
			}
			if bad := Explore(prog).Bad; len(bad) != 0 {
				t.Fatalf("Explore: expected clean, got %v", bad)
			}
		})
	}
}

func TestViolations(t *testing.T) {
	cases := map[string]struct {
		src    string
		reason string
	}{
		"aliased access during exclusive borrow": {`
			new x
			excl m = &mut x
			use x`, "aliased access during exclusive borrow m"},
		"mut owner while shared borrow lives": {`
			new x
			share r = &x
			mut x`, "mut x: borrowed by r"},
		"mut through shared borrow": {`
			new x
			share r = &x
			mut r`, "cannot write through a shared borrow"},
		"borrow outlives owner": {`
			new x
			share r = &x
			drop x`, "borrow r would outlive its owner"},
		"transferred borrow still outlives owner": {`
			new x
			excl m = &mut x
			move q = m
			drop x`, "borrow q would outlive its owner"},
		"move of borrowed owner": {`
			new x
			excl m = &mut x
			move y = x`, "owner borrowed by m"},
		"use after move": {`
			new x
			move y = x
			use x`, "use x: not live"},
		"second exclusive borrow": {`
			new x
			excl m = &mut x
			excl r = &mut x`, "borrow m is live"},
		"shared borrow during exclusive": {`
			new x
			excl m = &mut x
			share r = &x`, "exclusive borrow m is live"},
		"exclusive during shared": {`
			new x
			share r = &x
			excl m = &mut x`, "borrow r is live"},
		"incompatible merge: borrow in one branch": {`
			new x
			if { share r = &x } else { }`, "incompatible branch merge"},
		"incompatible merge: owner in one branch": {`
			if { new a } else { }`, `symbol "a" live in one branch only`},
		"incompatible merge: different kinds": {`
			new x
			if { share r = &x } else { excl r = &mut x }`, "incompatible branch merge"},
		"use of dead borrow after transfer": {`
			new x
			share r = &x
			move m = r
			use r`, "use r: not live"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			vs := Check(mustParse(t, tc.src))
			if len(vs) == 0 {
				t.Fatalf("expected a violation containing %q, got none", tc.reason)
			}
			if !strings.Contains(vs[0].Reason, tc.reason) {
				t.Fatalf("reason %q does not contain %q", vs[0].Reason, tc.reason)
			}
			if len(vs[0].Path) == 0 {
				t.Fatalf("violation has empty path")
			}
		})
	}
}

func TestViolationPath(t *testing.T) {
	prog := mustParse(t, `
		new x
		if { excl m = &mut x use x drop m } else { use x }
	`)
	vs := Check(prog)
	if len(vs) != 1 {
		t.Fatalf("expected 1 violation, got %v", vs)
	}
	want := []string{"new x", "if", "[then]", "excl m = &mut x", "use x"}
	got := vs[0].Path
	if len(got) != len(want) {
		t.Fatalf("path %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("path %v, want %v", got, want)
		}
	}
	if !strings.Contains(vs[0].Reason, "aliased access") {
		t.Fatalf("unexpected reason %q", vs[0].Reason)
	}
}

func TestParseErrors(t *testing.T) {
	for _, src := range []string{
		"new",
		"share r = x",
		"excl m = &x",
		"if { new x }",
		"if { new x } else {",
		"frobnicate x",
		"move = x",
	} {
		if _, err := Parse(src); err == nil {
			t.Fatalf("Parse(%q): expected error", src)
		}
	}
}
