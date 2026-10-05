package lease

import (
	"errors"
	"testing"
)

// partitionScript models: A holds the lease, the network partitions A
// away, the manager declares A dead and force-switches to B, B writes,
// then A heals and — never having seen the invalidation — tries to
// write with its stale fence.
func partitionScript() []Event {
	return []Event{
		{Kind: EvGrant, At: 0, Holder: "A", TTL: 100},
		{Kind: EvWrite, At: 1, Holder: "A", Fence: 1, Data: "a1"},
		{Kind: EvWrite, At: 2, Holder: "A", Fence: 1, Data: "a2"},
		{Kind: EvPartition, At: 3, Holder: "A"},
		// A cannot reach the manager to renew while partitioned.
		{Kind: EvRenew, At: 4, Holder: "A", Fence: 1, TTL: 100},
		// Manager declares A dead and cuts authority over to B.
		{Kind: EvForceSwitch, At: 5, Holder: "B", TTL: 50},
		{Kind: EvWrite, At: 6, Holder: "B", Fence: 2, Data: "b1"},
		{Kind: EvWrite, At: 7, Holder: "B", Fence: 2, Data: "b2"},
		// Partition heals; A still believes it holds the lease.
		{Kind: EvHeal, At: 8, Holder: "A"},
		{Kind: EvWrite, At: 9, Holder: "A", Fence: 1, Data: "a-stale"},
		{Kind: EvWrite, At: 10, Holder: "B", Fence: 2, Data: "b3"},
	}
}

func TestReplayPartitionNoDoubleLegalWrites(t *testing.T) {
	sim := NewSimulator()
	outcomes := sim.Replay(partitionScript())

	// The partitioned renew must have been skipped, not applied.
	if oc := outcomes[4]; !oc.Skipped || oc.Err == nil {
		t.Fatalf("partitioned renew: %+v; want skipped with error", oc)
	}

	// A's stale write after healing must be rejected by fencing.
	stale := outcomes[9]
	if stale.Accept || !errors.Is(stale.Err, ErrStaleFence) {
		t.Fatalf("stale write after heal: %+v; want ErrStaleFence", stale)
	}

	// Exactly five accepted writes: a1, a2, b1, b2, b3.
	writes := sim.S.Writes()
	if len(writes) != 5 {
		t.Fatalf("accepted writes = %d; want 5 (%+v)", len(writes), writes)
	}

	// Acceptance criterion: no double legal write anywhere in the replay.
	if c := Conflicts(writes); len(c) != 0 {
		t.Fatalf("double legal writes detected: %+v", c)
	}
}

func TestReplayIsDeterministic(t *testing.T) {
	script := partitionScript()
	sim := NewSimulator()
	first := sim.Replay(script)
	second := sim.Replay(script)
	if len(first) != len(second) {
		t.Fatalf("replay length changed: %d vs %d", len(first), len(second))
	}
	for i := range first {
		a, b := first[i], second[i]
		if a.Accept != b.Accept || a.Skipped != b.Skipped || a.Lease != b.Lease {
			t.Fatalf("outcome %d differs between replays: %+v vs %+v", i, a, b)
		}
	}
}

func TestReplayRenewalChainKeepsSingleAuthority(t *testing.T) {
	script := []Event{
		{Kind: EvGrant, At: 0, Holder: "A", TTL: 10},
		{Kind: EvWrite, At: 5, Holder: "A", Fence: 1, Data: "a1"},
		{Kind: EvRenew, At: 9, Holder: "A", Fence: 1, TTL: 10}, // [9,19), fence 2
		{Kind: EvWrite, At: 18, Holder: "A", Fence: 2, Data: "a2"},
		// Legal switch only after the renewed lease expires at t=19.
		{Kind: EvSwitch, At: 18, Holder: "B", TTL: 10}, // must fail
		{Kind: EvSwitch, At: 19, Holder: "B", TTL: 10}, // fence 3
		{Kind: EvWrite, At: 20, Holder: "B", Fence: 3, Data: "b1"},
		// A's old fence must be fenced out now.
		{Kind: EvWrite, At: 21, Holder: "A", Fence: 2, Data: "a-stale"},
	}
	sim := NewSimulator()
	outcomes := sim.Replay(script)

	if outcomes[4].Err == nil {
		t.Fatal("switch while A's renewed lease is valid must fail")
	}
	if outcomes[5].Err != nil || outcomes[5].Lease.Fence != 3 {
		t.Fatalf("switch at expiry: %+v", outcomes[5])
	}
	if oc := outcomes[7]; oc.Accept || !errors.Is(oc.Err, ErrStaleFence) {
		t.Fatalf("A's stale-fence write: %+v; want ErrStaleFence", oc)
	}
	if c := Conflicts(sim.S.Writes()); len(c) != 0 {
		t.Fatalf("double legal writes detected: %+v", c)
	}
	if n := len(sim.S.Writes()); n != 3 {
		t.Fatalf("accepted writes = %d; want 3", n)
	}
}

func TestReplayWriteAtExpiryBoundary(t *testing.T) {
	script := []Event{
		{Kind: EvGrant, At: 0, Holder: "A", TTL: 10},
		{Kind: EvWrite, At: 9, Holder: "A", Fence: 1, Data: "last-legal"},
		{Kind: EvWrite, At: 10, Holder: "A", Fence: 1, Data: "expired"},
		{Kind: EvSwitch, At: 10, Holder: "B", TTL: 10},
		{Kind: EvWrite, At: 10, Holder: "B", Fence: 2, Data: "b-first"},
	}
	sim := NewSimulator()
	outcomes := sim.Replay(script)

	if !outcomes[1].Accept {
		t.Fatal("write at t=9 (Expiry-1) must be accepted")
	}
	if outcomes[2].Accept {
		t.Fatal("write at t == Expiry must be rejected (exclusive deadline)")
	}
	if !outcomes[4].Accept {
		t.Fatal("B's write at t=10 under the new lease must be accepted")
	}
	if c := Conflicts(sim.S.Writes()); len(c) != 0 {
		t.Fatalf("double legal writes detected: %+v", c)
	}
}
