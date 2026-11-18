package formal

import (
	"errors"
	"testing"
)

func TestReserveCommitReleaseAccounting(t *testing.T) {
	calc := testTree(t)
	hold, err := calc.Reserve(Request{
		ID:        "r1",
		Node:      "a1",
		Resources: Resources{"cpu": 4},
	})
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if hold.State != Reserved || hold.Granted["cpu"] != 4 {
		t.Fatalf("hold = %+v", hold)
	}
	for _, node := range []string{"root", "a", "a1"} {
		usage, err := calc.NodeUsage(node)
		if err != nil {
			t.Fatalf("NodeUsage(%q): %v", node, err)
		}
		if usage.Used["cpu"] != 4 || usage.Reserved["cpu"] != 4 || usage.Allocated["cpu"] != 0 {
			t.Fatalf("%s usage = %+v", node, usage)
		}
	}

	committed, err := calc.Commit("r1")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if committed.State != Allocated {
		t.Fatalf("state = %q, want allocated", committed.State)
	}
	usage, _ := calc.NodeUsage("a1")
	if usage.Used["cpu"] != 4 || usage.Allocated["cpu"] != 4 || usage.Reserved["cpu"] != 0 {
		t.Fatalf("usage after commit = %+v", usage)
	}

	released, err := calc.Release("r1")
	if err != nil {
		t.Fatalf("Release: %v", err)
	}
	if released.Granted["cpu"] != 4 {
		t.Fatalf("released = %+v", released)
	}
	if err := calc.Check(); err != nil {
		t.Fatalf("Check: %v", err)
	}
	for _, node := range []string{"root", "a", "a1"} {
		usage, _ := calc.NodeUsage(node)
		if !usage.Used.IsZero() || !usage.Allocated.IsZero() || !usage.Reserved.IsZero() {
			t.Fatalf("%s not empty after release: %+v", node, usage)
		}
	}
}

func TestReserveIsAllOrNothing(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 4, "mem": 10}},
		{ID: "job", Parent: "root", Limit: Resources{"cpu": 10, "mem": 2}},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	_, err = calc.Reserve(Request{
		ID:        "too-big",
		Node:      "job",
		Resources: Resources{"cpu": 3, "mem": 3},
	})
	if !errors.Is(err, ErrInsufficientQuota) {
		t.Fatalf("error = %v, want ErrInsufficientQuota", err)
	}
	if got := calc.Holds(); len(got) != 0 {
		t.Fatalf("failed reservation left holds: %+v", got)
	}
	if err := calc.Check(); err != nil {
		t.Fatalf("Check after failed reservation: %v", err)
	}

	hold, err := calc.TryReserve(Request{
		ID:        "partial",
		Node:      "job",
		Resources: Resources{"cpu": 3, "mem": 3},
	})
	if err != nil {
		t.Fatalf("TryReserve: %v", err)
	}
	if hold.Granted["cpu"] != 3 || hold.Granted["mem"] != 2 {
		t.Fatalf("partial grant = %v, want cpu=3 mem=2", hold.Granted)
	}
}

func TestReserveOverlappingAncestors(t *testing.T) {
	calc, err := NewCalculator(Config{Nodes: []Node{
		{ID: "root", Limit: Resources{"cpu": 10}},
		{ID: "team", Parent: "root", Limit: Resources{"cpu": 6}},
		{ID: "queue", Parent: "team", Limit: Resources{"cpu": 4}},
		{ID: "job", Parent: "queue"},
	}})
	if err != nil {
		t.Fatalf("NewCalculator: %v", err)
	}
	first, err := calc.Reserve(Request{ID: "one", Node: "job", Resources: Resources{"cpu": 3}})
	if err != nil {
		t.Fatalf("Reserve one: %v", err)
	}
	if first.Granted["cpu"] != 3 {
		t.Fatalf("grant = %d, want 3", first.Granted["cpu"])
	}
	second, err := calc.TryReserve(Request{ID: "two", Node: "job", Resources: Resources{"cpu": 3}})
	if err != nil {
		t.Fatalf("Reserve two: %v", err)
	}
	if second.Granted["cpu"] != 1 {
		t.Fatalf("grant = %d, want 1 (queue bottleneck)", second.Granted["cpu"])
	}
	if err := calc.Check(); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

func TestReserveRejectsBadInputs(t *testing.T) {
	calc := testTree(t)
	if _, err := calc.Reserve(Request{Node: "missing", Resources: Resources{"cpu": 1}}); !errors.Is(err, ErrUnknownNode) {
		t.Fatalf("unknown node error = %v", err)
	}
	if _, err := calc.Reserve(Request{Node: "a1", Resources: Resources{"cpu": -1}}); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("negative error = %v", err)
	}
	if _, err := calc.Reserve(Request{ID: "x", Node: "a1", Resources: Resources{"cpu": 1}}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if _, err := calc.Reserve(Request{ID: "x", Node: "a1", Resources: Resources{"cpu": 1}}); !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("duplicate error = %v", err)
	}
	if _, err := calc.Commit("missing"); !errors.Is(err, ErrUnknownHold) {
		t.Fatalf("commit error = %v", err)
	}
	if _, err := calc.Release("missing"); !errors.Is(err, ErrUnknownHold) {
		t.Fatalf("release error = %v", err)
	}
}

func TestCommitIsIdempotent(t *testing.T) {
	calc := testTree(t)
	if _, err := calc.Reserve(Request{ID: "r", Node: "a1", Resources: Resources{"cpu": 1}}); err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	if _, err := calc.Commit("r"); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if _, err := calc.Commit("r"); err != nil {
		t.Fatalf("second Commit: %v", err)
	}
	usage, _ := calc.NodeUsage("a1")
	if usage.Allocated["cpu"] != 1 || usage.Reserved["cpu"] != 0 || usage.Used["cpu"] != 1 {
		t.Fatalf("usage = %+v", usage)
	}
}
