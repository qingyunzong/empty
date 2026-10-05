package quota

import (
	"errors"
	"strings"
	"testing"
)

func mustAdd(t *testing.T, s *Store, id string, limit int64) {
	t.Helper()
	if err := s.AddPrincipal(id, limit); err != nil {
		t.Fatalf("AddPrincipal(%q): %v", id, err)
	}
}

func TestRenameResolveAndOldAliasBilling(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "alpha", 100)
	if err := s.Rename("alpha", "beta"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	root, err := s.Resolve("alpha")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if root != "beta" {
		t.Fatalf("old alias resolved to %q, want %q", root, "beta")
	}
	// Consumption via the old alias is billed to the new root.
	if err := s.Consume("alpha", 30); err != nil {
		t.Fatalf("Consume via old alias: %v", err)
	}
	p := s.Principal("beta")
	if p.Balance != 70 || p.Consumed != 30 {
		t.Fatalf("new root billed wrong: balance=%d consumed=%d", p.Balance, p.Consumed)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("conservation: %v", err)
	}
}

func TestCycleReport(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "a", 10)
	if err := s.Rename("a", "x"); err != nil {
		t.Fatalf("Rename a->x: %v", err)
	}
	// Rename the root back onto its own old alias, closing a cycle a <-> x.
	if err := s.Rename("x", "a"); err != nil {
		t.Fatalf("Rename x->a: %v", err)
	}
	cycles := s.ReportCycles()
	if len(cycles) != 1 {
		t.Fatalf("ReportCycles found %d cycles, want 1: %v", len(cycles), cycles)
	}
	got := map[string]bool{}
	for _, n := range cycles[0] {
		got[n] = true
	}
	if !got["a"] || !got["x"] || len(cycles[0]) != 2 {
		t.Fatalf("cycle = %v, want {a, x}", cycles[0])
	}
	if _, err := s.Resolve("x"); err == nil {
		t.Fatal("Resolve into cycle succeeded, want CycleError")
	} else {
		var ce *CycleError
		if !errors.As(err, &ce) {
			t.Fatalf("error type %T, want *CycleError", err)
		}
	}
	if err := s.Consume("x", 1); err == nil {
		t.Fatal("Consume into cycle succeeded, want error")
	}
}

func TestMergeAtomicBalancesAndLeases(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "m1", 100)
	mustAdd(t, s, "m2", 200)
	if err := s.Consume("m1", 10); err != nil {
		t.Fatal(err)
	}
	if err := s.AcquireLease("m1", "L1", 20); err != nil {
		t.Fatal(err)
	}
	if err := s.AcquireLease("m2", "L2", 50); err != nil {
		t.Fatal(err)
	}
	if err := s.Merge("m1", "m2"); err != nil {
		t.Fatalf("Merge: %v", err)
	}
	p := s.Principal("m1")
	if p == nil {
		t.Fatal("m1 root missing after merge")
	}
	if p.Limit != 300 || p.Balance != 220 || p.Consumed != 10 {
		t.Fatalf("merged root: limit=%d balance=%d consumed=%d", p.Limit, p.Balance, p.Consumed)
	}
	if len(p.Leases) != 2 || p.Leases["L1"] != 20 || p.Leases["L2"] != 50 {
		t.Fatalf("merged leases: %v", p.Leases)
	}
	// Requests via the absorbed root's name bill the surviving root.
	if err := s.Consume("m2", 30); err != nil {
		t.Fatalf("Consume via merged alias: %v", err)
	}
	if p.Balance != 190 || p.Consumed != 40 {
		t.Fatalf("after merged-alias consume: balance=%d consumed=%d", p.Balance, p.Consumed)
	}
	// Leases acquired pre-merge still release onto the surviving root.
	if err := s.ReleaseLease("L2"); err != nil {
		t.Fatalf("ReleaseLease: %v", err)
	}
	if p.Balance != 240 {
		t.Fatalf("after release: balance=%d", p.Balance)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("conservation: %v", err)
	}
}

func TestFailedMergeIsAtomic(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "c1", 100)
	mustAdd(t, s, "c2", 100)
	if err := s.AcquireLease("c1", "L1", 10); err != nil {
		t.Fatal(err)
	}
	if err := s.AcquireLease("c2", "L2", 20); err != nil {
		t.Fatal(err)
	}
	// Put c2 behind a cycle so resolving it fails.
	if err := s.Rename("c2", "c2x"); err != nil {
		t.Fatal(err)
	}
	if err := s.Rename("c2x", "c2"); err != nil {
		t.Fatal(err)
	}
	if err := s.Merge("c1", "c2"); err == nil {
		t.Fatal("Merge with unresolvable source succeeded, want error")
	}
	// Nothing may have changed: c1's balance and leases intact.
	p1 := s.Principal("c1")
	if p1 == nil {
		t.Fatal("c1 root disappeared after aborted merge")
	}
	if p1.Balance != 90 || p1.Leases["L1"] != 10 {
		t.Fatalf("c1 mutated: balance=%d leases=%v", p1.Balance, p1.Leases)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("conservation: %v", err)
	}
}

func TestSplitRequiresNoActiveLeases(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "root", 100)
	if err := s.AcquireLease("root", "L", 40); err != nil {
		t.Fatal(err)
	}
	if err := s.Split("root", "child", 30); !errors.Is(err, ErrActiveLeases) {
		t.Fatalf("Split with active lease: %v, want ErrActiveLeases", err)
	}
	if err := s.ReleaseLease("L"); err != nil {
		t.Fatal(err)
	}
	if err := s.Split("root", "child", 30); err != nil {
		t.Fatalf("Split after release: %v", err)
	}
	parent, child := s.Principal("root"), s.Principal("child")
	if parent.Limit != 70 || parent.Balance != 70 {
		t.Fatalf("parent after split: limit=%d balance=%d", parent.Limit, parent.Balance)
	}
	if child.Limit != 30 || child.Balance != 30 {
		t.Fatalf("child after split: limit=%d balance=%d", child.Limit, child.Balance)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("conservation: %v", err)
	}
}

func TestConsumeInsufficient(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "poor", 5)
	if err := s.Consume("poor", 6); !errors.Is(err, ErrInsufficient) {
		t.Fatalf("Consume: %v, want ErrInsufficient", err)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("conservation: %v", err)
	}
}

func TestReplayRenameConsumeAndConservation(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "team-a", 100)
	mustAdd(t, s, "team-b", 200)

	log := `
# rebrand team-a, then merge team-b into it
rename team-a team-alpha
consume team-a 10        # billed to team-alpha via old alias
merge team-alpha team-b
consume team-b 40        # billed to merged root via old alias
lease team-alpha L9 25
commit L9
consume team-alpha 60
consume team-alpha 1000  # exceeds balance, must fail
`
	events, err := ParseEvents(strings.NewReader(log))
	if err != nil {
		t.Fatalf("ParseEvents: %v", err)
	}
	res := Replay(s, events)
	if len(res.Errors) != 1 {
		t.Fatalf("replay errors = %v, want exactly 1 (overdraft)", res.Errors)
	}
	if res.Applied != len(events)-1 {
		t.Fatalf("applied %d of %d events", res.Applied, len(events))
	}
	p := s.Principal("team-alpha")
	if p == nil {
		t.Fatal("team-alpha missing")
	}
	if p.Limit != 300 {
		t.Fatalf("merged limit = %d, want 300", p.Limit)
	}
	if p.Consumed != 10+40+25+60 {
		t.Fatalf("consumed = %d, want 135", p.Consumed)
	}
	if p.Balance != 300-135 {
		t.Fatalf("balance = %d, want 165", p.Balance)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("global conservation after replay: %v", err)
	}
}

func TestReplaySplitBlockedByLease(t *testing.T) {
	s := NewStore()
	mustAdd(t, s, "org", 500)
	events := []Event{
		{Op: "lease", Name: "org", Target: "L1", Amount: 100},
		{Op: "split", Name: "org", Target: "org-east", Amount: 200}, // must fail
		{Op: "release", Target: "L1"},
		{Op: "split", Name: "org", Target: "org-east", Amount: 200},
		{Op: "consume", Name: "org-east", Amount: 50},
	}
	res := Replay(s, events)
	if len(res.Errors) != 1 || !errors.Is(res.Errors[0].Err, ErrActiveLeases) {
		t.Fatalf("replay errors = %v, want one ErrActiveLeases", res.Errors)
	}
	org, east := s.Principal("org"), s.Principal("org-east")
	if org.Limit != 300 || east.Limit != 200 || east.Consumed != 50 {
		t.Fatalf("org=%+v east=%+v", org, east)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatalf("global conservation: %v", err)
	}
}
