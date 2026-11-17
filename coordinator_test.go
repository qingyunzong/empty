package formal

import (
	"context"
	"testing"
	"time"
)

const testKey = "user/42"

func newGroup(t *testing.T, n, r, w int) ([]*Replica, *fakeTransport, Config) {
	t.Helper()
	replicas := make([]*Replica, n)
	nodes := make([]string, n)
	for i := range replicas {
		id := nodeName(i)
		replicas[i] = NewReplica(id)
		nodes[i] = id
	}
	transport := NewFakeTransport(replicas...)
	cfg := Config{
		Nodes:          nodes,
		LocalNode:      nodes[0],
		R:              r,
		W:              w,
		RequestTimeout: 200 * time.Millisecond,
		RepairTimeout:  100 * time.Millisecond,
		MaxRepair:      n,
	}
	return replicas, transport, cfg
}

func nodeName(i int) string {
	return "r" + string(rune('1'+i))
}

func eventually(t *testing.T, timeout time.Duration, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !fn() {
		t.Fatal("condition not met before timeout")
	}
}

func liveValues(t *testing.T, c *Coordinator, key string) []string {
	t.Helper()
	live, _, err := c.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	values := make([]string, 0, len(live))
	for _, v := range live {
		values = append(values, string(v.Value))
	}
	return values
}

func TestReadQuorumAndBoundedReadRepair(t *testing.T) {
	replicas, transport, cfg := newGroup(t, 3, 2, 2)
	coord := NewCoordinator(cfg, transport)

	// r3 is down for the initial write, so it never learns v1.
	transport.Partition("r3")
	if _, err := coord.Put(context.Background(), testKey, []byte("v1")); err != nil {
		t.Fatalf("Put failed: %v", err)
	}
	coord.WaitBackground()

	if got := replicas[2].Snapshot(testKey); len(got) != 0 {
		t.Fatalf("partitioned r3 should hold nothing, got %+v", got)
	}

	// Heal and read: an R=2 quorum of r1/r2 returns v1 immediately, then the
	// bounded background read-repair must heal the stale r3.
	transport.Heal("r3")
	values := liveValues(t, coord, testKey)
	if len(values) != 1 || values[0] != "v1" {
		t.Fatalf("quorum read returned unexpected set: %v", values)
	}
	coord.WaitBackground()

	eventually(t, time.Second, func() bool {
		live, _ := Visible(replicas[2].Snapshot(testKey))
		return len(live) == 1 && string(live[0].Value) == "v1"
	})

	// All three replicas now agree.
	for i, r := range replicas {
		live, _ := Visible(r.Snapshot(testKey))
		if len(live) != 1 || string(live[0].Value) != "v1" {
			t.Fatalf("replica %d did not converge to v1: %+v", i, live)
		}
	}
}

func TestPartitionSiblingsAndConvergence(t *testing.T) {
	replicas, transport, cfg := newGroup(t, 4, 2, 2)

	coordA := NewCoordinator(cfg, transport)

	cfgB := cfg
	cfgB.Nodes = []string{"r3", "r4", "r1", "r2"}
	cfgB.LocalNode = "r3"
	coordB := NewCoordinator(cfgB, transport)

	if _, err := coordA.Put(context.Background(), testKey, []byte("alpha")); err != nil {
		t.Fatalf("initial put failed: %v", err)
	}
	coordA.WaitBackground()

	// Split into two halves, each holding a W=2 quorum. Coordinator A runs
	// from r1 and can only see group A; coordinator B runs from r3 and can
	// only see group B.
	transport.SetGroup("r1", "A")
	transport.SetGroup("r2", "A")
	transport.SetGroup("r3", "B")
	transport.SetGroup("r4", "B")

	if _, err := coordA.Put(context.Background(), testKey, []byte("side-a")); err != nil {
		t.Fatalf("partition A write failed: %v", err)
	}
	if _, err := coordB.Put(context.Background(), testKey, []byte("side-b")); err != nil {
		t.Fatalf("partition B write failed: %v", err)
	}

	// While partitioned, each side only sees its own branch.
	if values := liveValues(t, coordA, testKey); len(values) != 1 || values[0] != "side-a" {
		t.Fatalf("partition A should read only side-a, got %v", values)
	}
	if values := liveValues(t, coordB, testKey); len(values) != 1 || values[0] != "side-b" {
		t.Fatalf("partition B should read only side-b, got %v", values)
	}

	// Heal: a quorum read spanning both halves must surface the sibling set.
	for _, node := range cfg.Nodes {
		transport.Heal(node)
	}

	eventually(t, time.Second, func() bool {
		values := liveValues(t, coordA, testKey)
		return len(values) == 2
	})
	values := liveValues(t, coordA, testKey)
	if !contains(values, "side-a") || !contains(values, "side-b") {
		t.Fatalf("healed read must return both siblings, got %v", values)
	}

	coordA.WaitBackground()

	// A quorum read merges both branches into siblings, then a resolving
	// descendant write converges every replica to a single value.
	if _, err := coordA.Put(context.Background(), testKey, []byte("resolved")); err != nil {
		t.Fatalf("resolving put failed: %v", err)
	}
	coordA.WaitBackground()

	eventually(t, 2*time.Second, func() bool {
		for _, r := range replicas {
			live, _ := Visible(r.Snapshot(testKey))
			if len(live) != 1 || string(live[0].Value) != "resolved" {
				return false
			}
		}
		return true
	})
}

func TestLateTimeoutReplyCannotOverwriteNewVersion(t *testing.T) {
	replicas, transport, cfg := newGroup(t, 3, 2, 2)
	coord := NewCoordinator(cfg, transport)

	clock1, err := coord.Put(context.Background(), testKey, []byte("v1"))
	if err != nil {
		t.Fatalf("first put failed: %v", err)
	}
	coord.WaitBackground()

	// r3 falls behind and replies slowly; the quorum proceeds without it.
	transport.SetDelay("r3", 150*time.Millisecond)
	if _, err := coord.Put(context.Background(), testKey, []byte("v2")); err != nil {
		t.Fatalf("second put failed: %v", err)
	}

	// Even before r3 catches up, quorum reads must never observe v1.
	values := liveValues(t, coord, testKey)
	if len(values) != 1 || values[0] != "v2" {
		t.Fatalf("late replica must not expose stale version, got %v", values)
	}

	transport.SetDelay("r3", 0)
	coord.WaitBackground()

	// Directly delivering the obsolete clock after the fact is pruned at the
	// storage layer too.
	replicas[2].Apply(testKey, []Version{{Clock: clock1, Value: []byte("late-v1")}})
	live, _ := Visible(replicas[2].Snapshot(testKey))
	if len(live) != 1 || string(live[0].Value) != "v2" {
		t.Fatalf("late stale write overwrote new version: %+v", live)
	}

	eventually(t, time.Second, func() bool {
		for _, r := range replicas {
			live, _ := Visible(r.Snapshot(testKey))
			if len(live) != 1 || string(live[0].Value) != "v2" {
				return false
			}
		}
		return true
	})
}

func TestDeleteTombstoneCompactAndResurrection(t *testing.T) {
	replicas, transport, cfg := newGroup(t, 3, 2, 2)
	coord := NewCoordinator(cfg, transport)

	if _, err := coord.Put(context.Background(), testKey, []byte("doomed")); err != nil {
		t.Fatalf("put failed: %v", err)
	}
	if _, err := coord.Delete(context.Background(), testKey); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
	coord.WaitBackground()

	live, deleted, err := coord.Get(context.Background(), testKey)
	if err != nil {
		t.Fatalf("get after delete failed: %v", err)
	}
	if !deleted || len(live) != 0 {
		t.Fatalf("deleted key should report deleted with no live values, got %+v", live)
	}

	// The tombstone must still physically exist on every replica.
	for i, r := range replicas {
		snap := r.Snapshot(testKey)
		if len(snap) != 1 || !snap[0].Tombstone {
			t.Fatalf("replica %d should retain the tombstone, got %+v", i, snap)
		}
	}

	// Compact with a partitioned node must fail and keep every tombstone.
	transport.Partition("r3")
	if _, err := coord.Compact(context.Background(), testKey); err == nil {
		t.Fatal("compact must fail while a replica is unreachable")
	}
	if got := replicas[0].Snapshot(testKey); len(got) != 1 {
		t.Fatalf("failed compact must not remove tombstones, got %+v", got)
	}

	// After healing, compact advances the safe watermark and collects.
	transport.Heal("r3")
	collected, err := coord.Compact(context.Background(), testKey)
	if err != nil {
		t.Fatalf("compact after heal failed: %v", err)
	}
	if collected < 3 {
		t.Fatalf("expected all replicas to collect a tombstone, got %d", collected)
	}
	for i, r := range replicas {
		if len(r.Snapshot(testKey)) != 0 {
			t.Fatalf("replica %d still holds state after compact", i)
		}
	}

	// A stale partitioned survivor cannot resurrect the deleted value.
	replicas[0].Apply(testKey, []Version{{Clock: VClock{"r1": 1}, Value: []byte("ghost")}})
	if got := replicas[0].Snapshot(testKey); len(got) != 0 {
		t.Fatalf("deleted value resurrected: %+v", got)
	}
}

func TestQuorumUnavailableUnderMajorityPartition(t *testing.T) {
	_, transport, cfg := newGroup(t, 3, 2, 2)
	coord := NewCoordinator(cfg, transport)

	transport.Partition("r2")
	transport.Partition("r3")

	if _, err := coord.Put(context.Background(), testKey, []byte("x")); err == nil {
		t.Fatal("write must fail with only one healthy replica")
	}
	if _, _, err := coord.Get(context.Background(), testKey); err == nil {
		t.Fatal("read must fail with only one healthy replica")
	}
}

func contains(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}
