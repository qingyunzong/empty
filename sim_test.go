package jointsim

import (
	"strings"
	"testing"
)

type partition struct{ blocked map[string]bool }

func (p partition) Filter(m Message) (bool, int) {
	return p.blocked[m.From] || p.blocked[m.To], 0
}

type duplicator struct{ n int }

func (d duplicator) Filter(Message) (bool, int) { return false, d.n }

func TestJointConsensusHappyPath(t *testing.T) {
	sim := NewSim([]string{"A", "B", "C"}, "A", nil)
	sim.Propose("x=1")
	sim.Run()
	if got := sim.LeaderCommit(); got != 1 {
		t.Fatalf("commit=%d, want 1", got)
	}
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	sim.Run()
	// joint entry at 2, final entry at 3.
	if got := sim.LeaderCommit(); got != 3 {
		t.Fatalf("commit=%d, want 3", got)
	}
	// After the final config, the old-only nodes are no longer needed:
	// partition them away and the new set alone must still commit.
	sim.Faults = partition{blocked: map[string]bool{"B": true, "C": true}}
	sim.Propose("y=2")
	sim.Run()
	if got := sim.LeaderCommit(); got != 4 {
		t.Fatalf("commit=%d, want 4 (new set alone must commit after final)", got)
	}
	if err := CheckTrace(sim.Trace, []string{"A", "B", "C"}); err != nil {
		t.Fatalf("trace check: %v", err)
	}
	certs := Certificates(sim.Trace)
	if len(certs) != 4 {
		t.Fatalf("got %d certificates, want 4", len(certs))
	}
	joint := certs[1]
	if !joint.Config.IsJoint() {
		t.Fatalf("joint entry cert is not joint: %v", joint)
	}
	if !joint.Config.OldQuorum(toSet(joint.Voters)) || !joint.Config.NewQuorum(toSet(joint.Voters)) {
		t.Fatalf("joint cert lacks both majorities: %v", joint)
	}
	last := certs[3]
	if last.Config.IsJoint() {
		t.Fatalf("cert after final config is still joint: %v", last)
	}
	for _, v := range last.Voters {
		if v == "B" || v == "C" {
			t.Fatalf("old-only voter %q in post-final cert %v", v, last)
		}
	}
	for _, c := range certs {
		t.Log(c)
	}
}

func TestDuplicateConfigChangeIdempotent(t *testing.T) {
	sim := NewSim([]string{"A", "B", "C"}, "A", nil)
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		t.Fatalf("duplicate change must be an idempotent no-op: %v", err)
	}
	if err := sim.ChangeMembership([]string{"X", "Y", "Z"}); err == nil {
		t.Fatal("conflicting change during joint phase must be rejected")
	}
	sim.Run()
	joints, finals := 0, 0
	for _, e := range sim.LeaderLog() {
		if e.Cfg == nil {
			continue
		}
		if e.Cfg.IsJoint() {
			joints++
		} else {
			finals++
		}
	}
	if joints != 1 || finals != 1 {
		t.Fatalf("leader log has %d joint and %d final entries, want 1 each", joints, finals)
	}
	// After completion, repeating the same target is again a no-op.
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	if got := len(sim.LeaderLog()); got != 2 {
		t.Fatalf("leader log grew after completed duplicate change: %d entries", got)
	}
	if err := CheckTrace(sim.Trace, []string{"A", "B", "C"}); err != nil {
		t.Fatalf("trace check: %v", err)
	}
}

func TestDuplicateDeliveryIdempotent(t *testing.T) {
	sim := NewSim([]string{"A", "B", "C"}, "A", duplicator{n: 2})
	sim.Propose("cmd")
	sim.Run()
	for _, id := range []string{"A", "B", "C"} {
		n := sim.Node(id)
		if len(n.Log) != 1 {
			t.Fatalf("node %s log len=%d, want 1 (duplicates must be idempotent)", id, len(n.Log))
		}
		if n.Commit != 1 {
			t.Fatalf("node %s commit=%d, want 1", id, n.Commit)
		}
	}
	if got := len(Certificates(sim.Trace)); got != 1 {
		t.Fatalf("got %d commit events, want exactly 1", got)
	}
}

func TestJointPhaseNeedsBothMajorities(t *testing.T) {
	// Old {A,B,C} -> new {D,E,F}; leader A is removed by the change.
	// Scenario 1: only the old majority is reachable from the start. The
	// old set alone must not commit the joint entry.
	oldOnly := NewSim([]string{"A", "B", "C"}, "A",
		partition{blocked: map[string]bool{"D": true, "E": true, "F": true}})
	if err := oldOnly.ChangeMembership([]string{"D", "E", "F"}); err != nil {
		t.Fatal(err)
	}
	oldOnly.Run()
	if got := oldOnly.LeaderCommit(); got != 0 {
		t.Fatalf("old set alone committed entry %d during joint phase", got)
	}
	oldOnly.Faults = NoFaults{}
	oldOnly.Heartbeat()
	oldOnly.Run()
	if got := oldOnly.LeaderCommit(); got != 2 {
		t.Fatalf("commit=%d, want 2 (joint + final) after healing", got)
	}
	// Scenario 2: only the new majority is reachable from the start. The
	// uncommitted new set must not advance alone either.
	newOnly := NewSim([]string{"A", "B", "C"}, "A",
		partition{blocked: map[string]bool{"B": true, "C": true}})
	if err := newOnly.ChangeMembership([]string{"D", "E", "F"}); err != nil {
		t.Fatal(err)
	}
	newOnly.Run()
	if got := newOnly.LeaderCommit(); got != 0 {
		t.Fatalf("uncommitted new set alone committed entry %d during joint phase", got)
	}
	newOnly.Faults = NoFaults{}
	newOnly.Heartbeat()
	newOnly.Run()
	if got := newOnly.LeaderCommit(); got != 2 {
		t.Fatalf("commit=%d, want 2 (joint + final) after healing", got)
	}
	for _, sim := range []*Sim{oldOnly, newOnly} {
		if err := CheckTrace(sim.Trace, []string{"A", "B", "C"}); err != nil {
			t.Fatalf("trace check: %v", err)
		}
		for _, c := range Certificates(sim.Trace) {
			if !c.Config.IsJoint() {
				t.Fatalf("cert during joint phase is not joint: %v", c)
			}
			t.Log(c)
		}
	}
}

func TestSequentialMembershipChanges(t *testing.T) {
	sim := NewSim([]string{"A", "B", "C"}, "A", nil)
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	sim.Run()
	if err := sim.ChangeMembership([]string{"A", "F", "G"}); err != nil {
		t.Fatal(err)
	}
	sim.Run()
	if got := sim.LeaderCommit(); got != 4 {
		t.Fatalf("commit=%d, want 4", got)
	}
	sim.Propose("after")
	sim.Run()
	if got := sim.LeaderCommit(); got != 5 {
		t.Fatalf("commit=%d, want 5", got)
	}
	if err := CheckTrace(sim.Trace, []string{"A", "B", "C"}); err != nil {
		t.Fatalf("trace check: %v", err)
	}
	last := Certificates(sim.Trace)[4]
	if last.Config.IsJoint() || !equalMembers([]string{"A", "F", "G"}, last.Config.Old) {
		t.Fatalf("final cert must use the newest set only: %v", last)
	}
}

func TestCertificateOutput(t *testing.T) {
	sim := NewSim([]string{"A", "B", "C"}, "A", nil)
	sim.Propose("x=1")
	if err := sim.ChangeMembership([]string{"A", "D", "E"}); err != nil {
		t.Fatal(err)
	}
	sim.Run()
	certs := Certificates(sim.Trace)
	if len(certs) != 3 {
		t.Fatalf("got %d certificates, want 3", len(certs))
	}
	for _, c := range certs {
		if err := c.Verify(); err != nil {
			t.Fatalf("certificate does not verify: %v", err)
		}
		if !strings.Contains(c.String(), "old-voters=") {
			t.Fatalf("certificate output missing voter list: %q", c.String())
		}
	}
	if !strings.Contains(certs[1].String(), "new-voters=") {
		t.Fatalf("joint certificate output missing new voter list: %q", certs[1].String())
	}
}
