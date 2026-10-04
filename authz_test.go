package authz

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func TestSameLevelDenyPriority(t *testing.T) {
	gs := NewGroups()
	res := &Node{ID: "doc", Rules: []Rule{
		{Subject: "alice", Action: "read", Effect: Allow},
		{Subject: "alice", Action: "read", Effect: Deny},
	}}
	d := Evaluate("alice", "read", res, gs)
	if d.Allowed || !d.Matched {
		t.Fatalf("same-level deny must win, got allowed=%v matched=%v", d.Allowed, d.Matched)
	}
	if len(d.Hits) != 2 {
		t.Fatalf("expected both same-level rules reported, got %d hits", len(d.Hits))
	}
}

func TestNearestLevelShadowsAncestors(t *testing.T) {
	gs := NewGroups()
	root := &Node{ID: "root", Rules: []Rule{{Subject: "alice", Action: "read", Effect: Deny}}}
	leaf := &Node{ID: "leaf", Parent: root, Rules: []Rule{{Subject: "alice", Action: "read", Effect: Allow}}}

	if d := Evaluate("alice", "read", leaf, gs); !d.Allowed {
		t.Fatalf("nearer allow must shadow ancestor deny, got deny")
	}

	// Reverse: nearer deny shadows ancestor allow.
	root.Rules[0].Effect = Allow
	leaf.Rules[0].Effect = Deny
	if d := Evaluate("alice", "read", leaf, gs); d.Allowed {
		t.Fatalf("nearer deny must shadow ancestor allow, got allow")
	}
}

func TestNoMatchDefaultsToDeny(t *testing.T) {
	gs := NewGroups()
	root := &Node{ID: "root", Rules: []Rule{{Subject: "bob", Action: "read", Effect: Allow}}}
	leaf := &Node{ID: "leaf", Parent: root}
	d := Evaluate("alice", "read", leaf, gs)
	if d.Allowed || d.Matched {
		t.Fatalf("unmatched request must default to deny, got %+v", d)
	}
}

func TestGroupCycleClosureIsFinite(t *testing.T) {
	gs := NewGroups()
	// Cycle: a -> b -> c -> a, plus alice in a.
	gs.Add("a", "alice", "b")
	gs.Add("b", "c")
	gs.Add("c", "a")

	reach := gs.Reachable("alice")
	for _, g := range []string{"a", "b", "c"} {
		if _, ok := reach[g]; !ok {
			t.Fatalf("closure must contain %q, got %v", g, reach)
		}
	}
	if len(reach) != 3 {
		t.Fatalf("closure over a 3-cycle must be finite (3 groups), got %d", len(reach))
	}

	res := &Node{ID: "res", Rules: []Rule{{Subject: "c", Action: "read", Effect: Allow}}}
	d := Evaluate("alice", "read", res, gs)
	if !d.Allowed {
		t.Fatalf("alice must be allowed via cyclic group chain, got deny")
	}
	if got := d.Hits[0].GroupChain; got[0] != "alice" || got[len(got)-1] != "c" {
		t.Fatalf("group chain must run alice -> ... -> c, got %v", got)
	}
}

func TestHitPathOutput(t *testing.T) {
	gs := NewGroups()
	gs.Add("eng", "alice")
	gs.Add("staff", "eng")
	root := &Node{ID: "root", Rules: []Rule{{Subject: "staff", Action: "read", Effect: Allow}}}
	mid := &Node{ID: "team", Parent: root}
	leaf := &Node{ID: "doc", Parent: mid}

	d := Evaluate("alice", "read", leaf, gs)
	if !d.Allowed {
		t.Fatalf("expected allow via staff, got deny")
	}
	out := d.HitPath()
	for _, want := range []string{`"root"`, "doc -> team -> root", "staff", "alice -> eng -> staff"} {
		if !strings.Contains(out, want) {
			t.Fatalf("hit path missing %q:\n%s", want, out)
		}
	}
	t.Logf("hit path:\n%s", out)
}

// TestCorrectThenCrossCheck models an audit workflow: a misconfigured
// group and a mis-parented node produce wrong decisions; after each
// correction the evaluation is cross-checked against a full reachable
// scan of every resource.
func TestCorrectThenCrossCheck(t *testing.T) {
	gs := NewGroups()
	gs.Add("employees", "alice")
	gs.Add("contractors", "bob")
	// Misconfiguration 1: ext-eu (carol) should be nested under
	// contractors but is not yet.
	gs.Add("ext-eu", "carol")

	root := &Node{ID: "root", Rules: []Rule{
		{Subject: "employees", Action: "read", Effect: Allow},
		{Subject: "contractors", Action: "read", Effect: Deny},
	}}
	internal := &Node{ID: "internal", Parent: root}
	public := &Node{ID: "public", Parent: root, Rules: []Rule{
		{Subject: "contractors", Action: "read", Effect: Allow},
	}}
	// Misconfiguration 2: secret draft hangs under public instead of internal.
	draft := &Node{ID: "draft", Parent: public}

	all := []*Node{root, internal, public, draft}
	users := []string{"alice", "bob", "carol"}

	// Before the group fix, carol is not denied at root.
	if d := Evaluate("carol", "read", internal, gs); d.Allowed {
		t.Fatalf("pre-fix sanity: carol should be unmatched/denied at internal, got allow")
	}

	// Correction 1: nest ext-eu under contractors.
	gs.Add("contractors", "ext-eu")
	if d := Evaluate("carol", "read", internal, gs); d.Allowed || !d.Matched {
		t.Fatalf("after group fix carol must be denied via contractors, got %+v", d)
	}
	// But draft still leaks: public's allow shadows root's deny.
	if d := Evaluate("carol", "read", draft, gs); !d.Allowed {
		t.Fatalf("mis-parented draft should still leak to carol, got deny")
	}

	// Correction 2: reparent draft under internal.
	draft.Parent = internal
	if d := Evaluate("carol", "read", draft, gs); d.Allowed {
		t.Fatalf("after reparenting, carol must be denied on draft, got allow")
	}
	if d := Evaluate("alice", "read", draft, gs); !d.Allowed {
		t.Fatalf("alice must still be allowed on draft, got deny")
	}

	// Cross-check every user against every resource with a full scan.
	for _, u := range users {
		for _, res := range all {
			if err := CrossCheck(u, "read", res, gs); err != nil {
				t.Fatalf("cross-check failed for %s on %s: %v", u, res.ID, err)
			}
		}
	}
	t.Logf("post-fix hit path for carol/draft:\n%s", Evaluate("carol", "read", draft, gs).HitPath())
}

// TestCrossCheckRandomized compares Evaluate against the full reachable
// scan over randomly generated trees, rule sets, and cyclic groups.
func TestCrossCheckRandomized(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))

		users := []string{"u0", "u1", "u2", "u3"}
		groups := []string{"g0", "g1", "g2", "g3", "g4"}
		actions := []string{"read", "write"}
		subjects := append(append([]string{}, users...), groups...)

		gs := NewGroups()
		for _, g := range groups {
			// Random members, may include groups -> cycles possible.
			for _, s := range subjects {
				if rng.Intn(4) == 0 {
					gs.Add(g, s)
				}
			}
		}

		// Random tree of 8 nodes.
		nodes := []*Node{{ID: "n0"}}
		for i := 1; i < 8; i++ {
			parent := nodes[rng.Intn(len(nodes))]
			nodes = append(nodes, &Node{ID: fmt.Sprintf("n%d", i), Parent: parent})
		}
		for _, n := range nodes {
			for rng.Intn(3) == 0 { // 0+ rules per node
				effect := Allow
				if rng.Intn(2) == 0 {
					effect = Deny
				}
				action := actions[rng.Intn(len(actions))]
				if rng.Intn(4) == 0 {
					action = "*"
				}
				n.Rules = append(n.Rules, Rule{
					Subject: subjects[rng.Intn(len(subjects))],
					Action:  action,
					Effect:  effect,
				})
			}
		}

		for _, u := range users {
			for _, a := range actions {
				for _, res := range nodes {
					if err := CrossCheck(u, a, res, gs); err != nil {
						t.Fatalf("seed=%d user=%s action=%s res=%s: %v", seed, u, a, res.ID, err)
					}
				}
			}
		}
	}
}
