package linearchk

import (
	"strings"
	"testing"
)

func TestExploreStates(t *testing.T) {
	prog := mustParse(t, "new x")
	ex := Explore(prog)
	if len(ex.Bad) != 0 {
		t.Fatalf("unexpected bad: %v", ex.Bad)
	}
	want := []string{"", "x:owner;"}
	if len(ex.States) != len(want) {
		t.Fatalf("states %v, want %v", ex.States, want)
	}
	for i := range want {
		if ex.States[i] != want[i] {
			t.Fatalf("states %v, want %v", ex.States, want)
		}
	}
}

func TestExploreBadTransition(t *testing.T) {
	prog := mustParse(t, `
		new x
		excl m = &mut x
		use x
	`)
	ex := Explore(prog)
	if len(ex.Bad) != 1 {
		t.Fatalf("expected 1 bad transition, got %v", ex.Bad)
	}
	if !strings.Contains(ex.Bad[0].Reason, "aliased access") {
		t.Fatalf("unexpected reason %q", ex.Bad[0].Reason)
	}
	if got := ex.Bad[0].Path[len(ex.Bad[0].Path)-1]; got != "use x" {
		t.Fatalf("path should end at the offending command, got %v", ex.Bad[0].Path)
	}
}

func TestExploreJoin(t *testing.T) {
	prog := mustParse(t, `
		new x
		if { share r = &x } else { }
	`)
	ex := Explore(prog)
	if len(ex.Bad) != 1 {
		t.Fatalf("expected 1 bad join, got %v", ex.Bad)
	}
	if !strings.Contains(ex.Bad[0].Reason, "incompatible branch merge") {
		t.Fatalf("unexpected reason %q", ex.Bad[0].Reason)
	}
}

func TestExploreFinite(t *testing.T) {
	prog := mustParse(t, `
		new x
		if { share r = &x } else { excl m = &mut x }
		if { use x } else { use x }
	`)
	ex := Explore(prog)
	// The state space over {x, r, m} is finite; this program must
	// terminate with a bounded number of reachable states.
	if n := len(ex.States); n == 0 || n > 64 {
		t.Fatalf("implausible state count %d", n)
	}
	// Both branches of the first if leave different borrows live,
	// so the join is incompatible.
	if len(ex.Bad) == 0 {
		t.Fatalf("expected the incompatible join to be reported")
	}
}
