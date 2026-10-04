package arb

import "testing"

// TestConfigChangeEndToEnd drives a full switch old -> joint -> new and
// checks the commit rule and the recorded evidence at every step.
func TestConfigChangeEndToEnd(t *testing.T) {
	oldCfg := mustConfig(t, map[string]int{"a": 1, "b": 1, "c": 1}) // quorum 2
	newCfg := mustConfig(t, map[string]int{"c": 1, "d": 2, "e": 1}) // total 4, quorum 3
	c := NewCluster(oldCfg)

	// Step 1: enter the joint phase; the joint entry commits under the
	// old config's rules (majority of old only).
	ev, ok := c.EnterJoint(0, newCfg, []string{"a", "b"})
	if !ok {
		t.Fatal("joint entry must commit with an old-config majority")
	}
	if ev.Phase != PhaseOld || len(ev.Tallies) != 1 {
		t.Fatalf("joint entry evidence: phase=%s tallies=%d, want old/1", ev.Phase, len(ev.Tallies))
	}
	if c.Phase() != PhaseJoint {
		t.Fatal("cluster must be in the joint phase")
	}

	// Step 2: in the joint phase an old-only majority is not enough.
	if _, ok := c.Propose(1, "x", []string{"a", "b"}); ok {
		t.Fatal("joint phase: old-only majority must not commit")
	}

	// Step 3: a majority of EACH config commits; evidence has 2 tallies.
	ev, ok = c.Propose(1, "x", []string{"a", "b", "c", "d"})
	if !ok {
		t.Fatal("joint phase: majorities of old and new must commit")
	}
	if ev.Phase != PhaseJoint || len(ev.Tallies) != 2 {
		t.Fatalf("joint commit evidence: phase=%s tallies=%d, want joint/2", ev.Phase, len(ev.Tallies))
	}
	for _, tl := range ev.Tallies {
		if !tl.Pass || tl.YesWeight < tl.Need {
			t.Fatalf("joint commit with failing tally: %+v", tl)
		}
	}

	// Step 4: the new-config entry commits under joint rules.
	ev, ok = c.LeaveJoint(2, []string{"a", "b", "c", "d"})
	if !ok {
		t.Fatal("new-config entry must commit under joint rules")
	}
	if len(ev.Tallies) != 2 {
		t.Fatalf("switch entry evidence: tallies=%d, want 2", len(ev.Tallies))
	}
	if c.Phase() != PhaseNew {
		t.Fatal("cluster must be in the new phase")
	}

	// Step 5: after the switch only the new config decides. A weighted
	// strict majority of the new config (c=1 + d=2 = 3 of 4) commits.
	ev, ok = c.Propose(3, "y", []string{"c", "d"})
	if !ok {
		t.Fatal("new phase: new-config weighted majority must commit")
	}
	if ev.Phase != PhaseNew || len(ev.Tallies) != 1 {
		t.Fatalf("new-phase evidence: phase=%s tallies=%d, want new/1", ev.Phase, len(ev.Tallies))
	}

	// Old-config members alone can no longer commit anything.
	if _, ok := c.Propose(4, "z", []string{"a", "b"}); ok {
		t.Fatal("new phase: old-config majority must not commit")
	}

	// Every commit produced evidence; print it for the audit log.
	if len(c.Evidence) != 4 {
		t.Fatalf("evidence entries=%d, want 4", len(c.Evidence))
	}
	for _, e := range c.Evidence {
		t.Log(e.String())
	}
	if len(c.Violations) != 0 {
		t.Fatalf("violations: %v", c.Violations)
	}
}

// newClusterInPhase builds a cluster directly in the given phase (test
// helper for the exhaustive safety check).
func newClusterInPhase(oldCfg, newCfg Config, phase Phase) *Cluster {
	c := NewCluster(oldCfg)
	c.new = newCfg
	c.phase = phase
	for id := range newCfg.Weights {
		if _, ok := c.nodes[id]; !ok {
			c.nodes[id] = &Node{ID: id, votedFor: map[int]string{}}
		}
	}
	return c
}

// TestNoConflictingCommitsExhaustive enumerates, for every phase, every
// pair of voter sets (A asked to commit "X", B asked to commit "Y") in
// both orders, and verifies that two conflicting values never both
// commit at the same index.
func TestNoConflictingCommitsExhaustive(t *testing.T) {
	oldCfg := mustConfig(t, map[string]int{"a": 1, "b": 1, "c": 1})
	newCfg := mustConfig(t, map[string]int{"c": 2, "d": 1, "e": 1})
	ids := []string{"a", "b", "c", "d", "e"}
	all := subsets(ids)
	phases := []Phase{PhaseOld, PhaseJoint, PhaseNew}

	checked := 0
	for _, phase := range phases {
		for _, av := range all {
			for _, bv := range all {
				for _, order := range []int{0, 1} {
					c := newClusterInPhase(oldCfg, newCfg, phase)
					_, okX := c.Propose(0, "X", av)
					_, okY := c.Propose(0, "Y", bv)
					if order == 1 {
						c2 := newClusterInPhase(oldCfg, newCfg, phase)
						_, okY2 := c2.Propose(0, "Y", bv)
						_, okX2 := c2.Propose(0, "X", av)
						if okX2 && okY2 {
							t.Fatalf("phase=%s order=rev: X via %v and Y via %v both committed",
								phase, av, bv)
						}
						if len(c2.Violations) != 0 {
							t.Fatalf("phase=%s violations: %v", phase, c2.Violations)
						}
					}
					if okX && okY {
						t.Fatalf("phase=%s: X via %v and Y via %v both committed",
							phase, av, bv)
					}
					if len(c.Violations) != 0 {
						t.Fatalf("phase=%s violations: %v", phase, c.Violations)
					}
					checked++
				}
			}
		}
	}
	t.Logf("exhaustive scenarios checked: %d", checked)
}
