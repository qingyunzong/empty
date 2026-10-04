package authz

import (
	"strings"
	"testing"
)

// buildFixture creates:
//
//	root(allow:admins)
//	├── eng(allow:eng-leads, deny:carol)
//	│   └── repo
//	└── ops(deny:contractors)
//	    └── wiki(allow:contractors)
//
// groups: admins={alice}, eng-leads={bob}, contractors={dave},
// cycle-a={cycle-b}, cycle-b={cycle-a, eve}
func buildFixture(t *testing.T) (*Node, map[string]*Node, *Directory, []string) {
	t.Helper()
	root := NewNode("root")
	eng := root.AddChild(NewNode("eng"))
	repo := eng.AddChild(NewNode("repo"))
	ops := root.AddChild(NewNode("ops"))
	wiki := ops.AddChild(NewNode("wiki"))

	root.Rules = []Rule{{Subject: "admins", Effect: Allow}}
	eng.Rules = []Rule{{Subject: "eng-leads", Effect: Allow}, {Subject: "carol", Effect: Deny}}
	ops.Rules = []Rule{{Subject: "contractors", Effect: Deny}}
	wiki.Rules = []Rule{{Subject: "contractors", Effect: Allow}}

	d := NewDirectory()
	for _, u := range []string{"alice", "bob", "carol", "dave", "eve", "mallory"} {
		d.AddUser(u)
	}
	for _, g := range []string{"admins", "eng-leads", "contractors", "cycle-a", "cycle-b"} {
		d.AddGroup(g)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(d.AddMember("admins", "alice"))
	must(d.AddMember("eng-leads", "bob"))
	must(d.AddMember("contractors", "dave"))
	must(d.AddMember("cycle-a", "cycle-b"))
	must(d.AddMember("cycle-b", "cycle-a")) // cycle on purpose
	must(d.AddMember("cycle-b", "eve"))

	nodes := map[string]*Node{"root": root, "eng": eng, "repo": repo, "ops": ops, "wiki": wiki}
	users := []string{"alice", "bob", "carol", "dave", "eve", "mallory"}
	return root, nodes, d, users
}

func TestSameLevelDenyWins(t *testing.T) {
	_, nodes, d, _ := buildFixture(t)
	// carol is denied directly on eng; add her to eng-leads so both effects
	// match at the same level. Deny must win.
	if err := d.AddMember("eng-leads", "carol"); err != nil {
		t.Fatal(err)
	}
	dec := Evaluate(nodes["repo"], d, "carol")
	if !dec.Matched || dec.Allowed {
		t.Fatalf("expected matched deny, got %s", dec)
	}
	if len(dec.Hits) != 2 {
		t.Fatalf("expected 2 hits at deciding level, got %v", dec.Hits)
	}
}

func TestNearestLevelShadowsAncestors(t *testing.T) {
	_, nodes, d, _ := buildFixture(t)

	// alice is allowed at root; eng has no rule for her, so root decides.
	dec := Evaluate(nodes["repo"], d, "alice")
	if !dec.Allowed || dec.Hits[0].Node != "root" {
		t.Fatalf("expected allow inherited from root, got %s", dec)
	}

	// dave is denied at ops but allowed at the nearer wiki level.
	dec = Evaluate(nodes["wiki"], d, "dave")
	if !dec.Allowed || dec.Hits[0].Node != "wiki" {
		t.Fatalf("expected wiki allow to shadow ops deny, got %s", dec)
	}

	// On ops itself only the deny exists.
	dec = Evaluate(nodes["ops"], d, "dave")
	if dec.Allowed || dec.Hits[0].Node != "ops" {
		t.Fatalf("expected deny at ops, got %s", dec)
	}
}

func TestHitPathReportsGroupChain(t *testing.T) {
	_, nodes, d, _ := buildFixture(t)
	dec := Evaluate(nodes["repo"], d, "bob")
	if !dec.Allowed {
		t.Fatalf("expected allow, got %s", dec)
	}
	wantPath := []string{"repo", "eng"}
	if strings.Join(dec.Path, ",") != strings.Join(wantPath, ",") {
		t.Fatalf("unexpected walk path %v", dec.Path)
	}
	h := dec.Hits[0]
	if h.Subject != "eng-leads" || strings.Join(h.Via, "->") != "bob->eng-leads" {
		t.Fatalf("unexpected hit %s", h)
	}
}

func TestCyclicGroupsHaveFiniteClosure(t *testing.T) {
	_, nodes, d, _ := buildFixture(t)
	paths := d.GroupPaths("eve")
	for _, g := range []string{"cycle-a", "cycle-b"} {
		if _, ok := paths[g]; !ok {
			t.Fatalf("eve should reach %s, closure=%v", g, paths)
		}
	}
	if len(paths) != 2 {
		t.Fatalf("closure must be finite, got %v", paths)
	}

	// A rule for cycle-a on root must match eve through the cyclic nesting.
	nodes["root"].Rules = append(nodes["root"].Rules, Rule{Subject: "cycle-a", Effect: Allow})
	dec := Evaluate(nodes["repo"], d, "eve")
	if !dec.Allowed || dec.Hits[0].Subject != "cycle-a" {
		t.Fatalf("expected allow via cyclic group, got %s", dec)
	}
}

func TestDefaultDenyWhenNothingMatches(t *testing.T) {
	_, nodes, d, _ := buildFixture(t)
	dec := Evaluate(nodes["repo"], d, "mallory")
	if dec.Matched || dec.Allowed {
		t.Fatalf("expected unmatched default deny, got %s", dec)
	}
}

func TestSetParentRejectsCycles(t *testing.T) {
	_, nodes, _, _ := buildFixture(t)
	if err := nodes["eng"].SetParent(nodes["repo"]); err == nil {
		t.Fatal("reparenting eng under its own descendant must fail")
	}
	if err := nodes["root"].SetParent(nodes["wiki"]); err == nil {
		t.Fatal("reparenting root under a descendant must fail")
	}
}

// TestCorrectionRecheckedByFullScan verifies the bottom-up evaluator against
// the independent top-down full scan, then applies corrections (a wrong
// group edge and a misplaced parent) and re-verifies both still agree.
func TestCorrectionRecheckedByFullScan(t *testing.T) {
	root, nodes, d, users := buildFixture(t)

	// Plant two mistakes: dave was added to eng-leads by accident, and the
	// wiki node was mounted under eng instead of ops.
	if err := d.AddMember("eng-leads", "dave"); err != nil {
		t.Fatal(err)
	}
	if err := nodes["wiki"].SetParent(nodes["eng"]); err != nil {
		t.Fatal(err)
	}

	if problems := Verify(root, d, users); len(problems) > 0 {
		t.Fatalf("evaluator and scan disagree before correction:\n%s", strings.Join(problems, "\n"))
	}
	if dec := Evaluate(nodes["repo"], d, "dave"); !dec.Allowed {
		t.Fatalf("mistake not planted: dave should reach repo, got %s", dec)
	}

	// Correction 1: remove dave from eng-leads.
	d.RemoveMember("eng-leads", "dave")
	// Correction 2: move wiki back under ops.
	if err := nodes["wiki"].SetParent(nodes["ops"]); err != nil {
		t.Fatal(err)
	}

	if problems := Verify(root, d, users); len(problems) > 0 {
		t.Fatalf("evaluator and scan disagree after correction:\n%s", strings.Join(problems, "\n"))
	}
	if dec := Evaluate(nodes["repo"], d, "dave"); dec.Allowed {
		t.Fatalf("correction ineffective: dave still reaches repo: %s", dec)
	}
	if dec := Evaluate(nodes["wiki"], d, "dave"); !dec.Allowed {
		t.Fatalf("wiki should allow contractors again, got %s", dec)
	}
}
