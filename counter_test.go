package epochcounter

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestIncrementDecrementValue(t *testing.T) {
	c := New("r1")
	c.Increment(5)
	c.Decrement(2)
	if got := c.Value(); got != 3 {
		t.Fatalf("Value() = %d, want 3", got)
	}
}

func TestResetRequiresLargerSeq(t *testing.T) {
	c := New("r1")
	c.Increment(10)

	if c.Reset(Epoch{Seq: 0, Issuer: "auth"}) {
		t.Fatal("reset with equal seq must be rejected")
	}
	if got := c.Value(); got != 10 {
		t.Fatalf("value changed after rejected reset: %d", got)
	}
	if !c.Reset(Epoch{Seq: 1, Issuer: "auth"}) {
		t.Fatal("reset with larger seq must be accepted")
	}
	if got := c.Value(); got != 0 {
		t.Fatalf("value after reset = %d, want 0", got)
	}
	if c.Reset(Epoch{Seq: 1, Issuer: "auth"}) {
		t.Fatal("reset replayed with same seq must be rejected")
	}
}

func TestOldEpochCannotResurrect(t *testing.T) {
	a := New("a")
	b := New("b")
	a.Increment(7)
	b.Merge(a.Snapshot()) // b learns epoch-0 count of 7

	// Authority resets everyone into epoch 1.
	e1 := Epoch{Seq: 1, Issuer: "auth"}
	a.Reset(e1)
	b.Reset(e1)
	a.Increment(2)
	b.Merge(a.Snapshot())
	if got := b.Value(); got != 2 {
		t.Fatalf("post-reset value = %d, want 2", got)
	}

	// A stale epoch-0 snapshot (7 increments) arrives late at b.
	stale := State{Epoch: Epoch{Seq: 0, Issuer: ""}, P: map[string]uint64{"a": 7}}
	if b.Merge(stale) {
		t.Fatal("stale epoch message must be dropped")
	}
	if got := b.Value(); got != 2 {
		t.Fatalf("old epoch resurrected counts: value = %d, want 2", got)
	}
}

func TestMergeReplayIdempotent(t *testing.T) {
	a := New("a")
	a.Increment(3)
	a.Decrement(1)
	snap := a.Snapshot()

	b := New("b")
	b.Merge(snap)
	first := b.Snapshot()
	for i := 0; i < 5; i++ {
		if b.Merge(snap) {
			t.Fatal("replayed merge reported a change")
		}
	}
	if !reflect.DeepEqual(first, b.Snapshot()) {
		t.Fatal("replayed merge mutated state")
	}
	if got := b.Value(); got != 2 {
		t.Fatalf("Value() = %d, want 2", got)
	}
}

func TestSameEpochMergeTakesComponentMax(t *testing.T) {
	a, b := New("a"), New("b")
	a.Increment(4)
	b.Increment(9)
	b.Decrement(1)

	sa, sb := a.Snapshot(), b.Snapshot()
	a.Merge(sb)
	b.Merge(sa)

	if a.Value() != 12 || b.Value() != 12 {
		t.Fatalf("converged values = %d, %d; want 12, 12", a.Value(), b.Value())
	}
	if !reflect.DeepEqual(a.Snapshot(), b.Snapshot()) {
		t.Fatal("same-epoch merge did not converge")
	}
}

// message is an in-flight snapshot delivery.
type message struct {
	to    int
	state State
}

// TestPartitionReplayConvergence simulates a cluster that splits into
// two partitions, experiences an authoritative reset mid-partition,
// suffers message replay and cross-epoch delay, then heals. It checks
// per-epoch conservation and final convergence of every replica.
func TestPartitionReplayConvergence(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	const nReplicas = 6

	replicas := make([]*Counter, nReplicas)
	for i := range replicas {
		replicas[i] = New(fmt.Sprintf("r%d", i))
	}

	// netOps[epoch][replica] tracks the authoritative net operations
	// issued by each replica within each epoch, for conservation checks.
	netOps := map[uint64][]int64{}
	var queue []message

	// partitionOf assigns replicas to network partitions; replicas in
	// different partitions cannot exchange messages.
	partitionOf := func(id int) int { return id % 2 }

	gossip := func(from int) {
		snap := replicas[from].Snapshot()
		for to := 0; to < nReplicas; to++ {
			if to == from || partitionOf(to) != partitionOf(from) {
				continue
			}
			queue = append(queue, message{to: to, state: snap})
			// 25% chance the network duplicates the message (replay).
			if rng.Intn(4) == 0 {
				queue = append(queue, message{to: to, state: snap})
			}
		}
	}

	deliver := func(m message) { replicas[m.to].Merge(m.state) }

	// Phase 1: epoch 0, partitioned random traffic.
	netOps[0] = make([]int64, nReplicas)
	for step := 0; step < 200; step++ {
		id := rng.Intn(nReplicas)
		delta := uint64(rng.Intn(5) + 1)
		if rng.Intn(2) == 0 {
			replicas[id].Increment(delta)
			netOps[0][id] += int64(delta)
		} else {
			replicas[id].Decrement(delta)
			netOps[0][id] -= int64(delta)
		}
		gossip(id)
		// Deliver a random subset of in-flight messages.
		keep := queue[:0]
		for _, m := range queue {
			if rng.Intn(2) == 0 {
				deliver(m)
			} else {
				keep = append(keep, m)
			}
		}
		queue = keep
	}

	// Phase 2: authority issues epoch 1 while the partition persists.
	// The reset reaches replicas at different times; some epoch-0
	// messages are still in flight and must not resurrect old counts.
	e1 := Epoch{Seq: 1, Issuer: "authority"}
	for _, id := range []int{0, 2, 4} { // partition A learns first
		if !replicas[id].Reset(e1) {
			t.Fatalf("replica %d rejected authoritative reset", id)
		}
	}
	// Epoch-0 stragglers delivered to already-reset replicas: dropped.
	for _, m := range queue {
		deliver(m)
	}
	queue = nil
	for _, id := range []int{0, 2, 4} {
		if got := replicas[id].Epoch().Seq; got != 1 {
			t.Fatalf("replica %d epoch = %d after stale delivery, want 1", id, got)
		}
	}
	// Partition B resets later, then everyone counts in epoch 1.
	for _, id := range []int{1, 3, 5} {
		replicas[id].Reset(e1)
	}
	netOps[1] = make([]int64, nReplicas)
	for step := 0; step < 200; step++ {
		id := rng.Intn(nReplicas)
		delta := uint64(rng.Intn(5) + 1)
		if rng.Intn(2) == 0 {
			replicas[id].Increment(delta)
			netOps[1][id] += int64(delta)
		} else {
			replicas[id].Decrement(delta)
			netOps[1][id] -= int64(delta)
		}
		gossip(id)
		for len(queue) > 0 && rng.Intn(2) == 0 {
			m := queue[0]
			queue = queue[1:]
			deliver(m)
		}
	}

	// Phase 3: heal the partition and gossip to quiescence.
	partitionOf = func(int) int { return 0 }
	for round := 0; round < nReplicas; round++ {
		for id := range replicas {
			gossip(id)
		}
		for _, m := range queue {
			deliver(m)
		}
		queue = nil
	}

	// Conservation within the surviving epoch: the converged value must
	// equal the exact net of operations issued in epoch 1.
	var want int64
	for _, d := range netOps[1] {
		want += d
	}
	for id, r := range replicas {
		if got := r.Value(); got != want {
			t.Errorf("replica %d value = %d, want conserved epoch-1 net %d", id, got, want)
		}
	}

	// Final convergence: every replica holds byte-identical state.
	ref := replicas[0].Snapshot()
	for id := 1; id < nReplicas; id++ {
		if !reflect.DeepEqual(ref, replicas[id].Snapshot()) {
			t.Errorf("replica %d diverged from replica 0: %+v vs %+v",
				id, replicas[id].Snapshot(), ref)
		}
	}
	if ref.Epoch != e1 {
		t.Errorf("converged epoch = %+v, want %+v", ref.Epoch, e1)
	}
	t.Logf("converged: epoch=%d value=%d replicas=%d", ref.Epoch.Seq, want, nReplicas)
}

// TestPerEpochConservationAcrossResets checks conservation at each
// epoch boundary across several sequential resets with full gossip.
func TestPerEpochConservationAcrossResets(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	const nReplicas = 4

	replicas := make([]*Counter, nReplicas)
	for i := range replicas {
		replicas[i] = New(fmt.Sprintf("r%d", i))
	}

	syncAll := func() {
		snaps := make([]State, nReplicas)
		for i, r := range replicas {
			snaps[i] = r.Snapshot()
		}
		for _, r := range replicas {
			for _, s := range snaps {
				r.Merge(s)
			}
		}
	}

	for epoch := uint64(0); epoch < 5; epoch++ {
		if epoch > 0 {
			e := Epoch{Seq: epoch, Issuer: "authority"}
			for _, r := range replicas {
				r.Reset(e)
			}
		}
		var want int64
		for step := 0; step < 50; step++ {
			id := rng.Intn(nReplicas)
			delta := uint64(rng.Intn(9) + 1)
			if rng.Intn(2) == 0 {
				replicas[id].Increment(delta)
				want += int64(delta)
			} else {
				replicas[id].Decrement(delta)
				want -= int64(delta)
			}
		}
		syncAll()
		for id, r := range replicas {
			if got := r.Value(); got != want {
				t.Fatalf("epoch %d: replica %d value = %d, want %d", epoch, id, got, want)
			}
			if got := r.Epoch().Seq; got != epoch {
				t.Fatalf("epoch %d: replica %d reports epoch %d", epoch, id, got)
			}
		}
	}
}
