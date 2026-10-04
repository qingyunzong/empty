package quota

import (
	"errors"
	"testing"
)

// TestReplayRenameAndConsumeConservesQuota replays a mixed log of rename
// and consume events and checks global quota conservation at the end.
func TestReplayRenameAndConsumeConservesQuota(t *testing.T) {
	s := NewStore()
	events := []Event{
		{Kind: EventSetLimit, Name: "alice", Amount: 100},
		{Kind: EventSetLimit, Name: "alice-v2", Amount: 50},
		{Kind: EventSetLimit, Name: "bob", Amount: 200},
		{Kind: EventRename, Name: "alice", Target: "alice-v2"}, // alice renamed; old name stays as alias
		{Kind: EventConsume, Name: "alice", Amount: 30},        // charged along to the new root
		{Kind: EventConsume, Name: "alice-v2", Amount: 20},
		{Kind: EventConsume, Name: "bob", Amount: 150},
		{Kind: EventConsume, Name: "bob", Amount: 100}, // exceeds: 150+100 > 200, skipped
		{Kind: EventAcquire, Name: "alice", LeaseID: "L1", Amount: 40},
		{Kind: EventRename, Name: "bob", Target: "alice-v2"}, // bob merges in, leases follow
		{Kind: EventRelease, Name: "bob", LeaseID: "L1"},
		{Kind: EventConsume, Name: "bob", Amount: 60},
		{Kind: EventRename, Name: "alice", Target: "bob"}, // cycle: rejected and reported
	}
	errs := s.Replay(events)
	if len(errs) != 2 {
		t.Fatalf("replay errors=%v, want exactly 2 (over-limit consume, cycle rename)", errs)
	}
	if !errors.Is(errs[0].Err, ErrLimitExceeded) {
		t.Fatalf("errs[0]=%v, want ErrLimitExceeded", errs[0])
	}

	root, limit, used, leased := s.Snapshot("alice")
	if want := s.Resolve("bob"); root != want {
		t.Fatalf("root=%q, want %q (shared with bob)", root, want)
	}
	if limit != 350 || used != 260 || leased != 0 {
		t.Fatalf("limit=%d used=%d leased=%d, want 350/260/0", limit, used, leased)
	}
	cycles := s.Cycles()
	if len(cycles) != 1 {
		t.Fatalf("cycles=%v, want 1 report", cycles)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}

// TestReplaySplitBlockedByLease exercises the split guard inside a replay.
func TestReplaySplitBlockedByLease(t *testing.T) {
	s := NewStore()
	events := []Event{
		{Kind: EventSetLimit, Name: "x", Amount: 80},
		{Kind: EventSetLimit, Name: "y", Amount: 120},
		{Kind: EventRename, Name: "x", Target: "y"},
		{Kind: EventConsume, Name: "x", Amount: 30},
		{Kind: EventAcquire, Name: "y", LeaseID: "L", Amount: 50},
		{Kind: EventSplit, Name: "x", Target: "y"}, // rejected: lease active
		{Kind: EventRelease, Name: "x", LeaseID: "L"},
		{Kind: EventSplit, Name: "x", Target: "y"}, // now allowed
	}
	errs := s.Replay(events)
	if len(errs) != 1 || !errors.Is(errs[0].Err, ErrActiveLeases) {
		t.Fatalf("replay errors=%v, want one ErrActiveLeases", errs)
	}
	if _, limit, used, _ := s.Snapshot("x"); limit != 80 || used != 30 {
		t.Fatalf("x: limit=%d used=%d, want 80/30", limit, used)
	}
	if _, limit, used, _ := s.Snapshot("y"); limit != 120 || used != 0 {
		t.Fatalf("y: limit=%d used=%d, want 120/0", limit, used)
	}
	if err := s.VerifyConservation(); err != nil {
		t.Fatal(err)
	}
}
