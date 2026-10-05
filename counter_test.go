package epochcounter

import (
	"fmt"
	"testing"
)

// network simulates gossip between replicas with optional directed link
// blocks (partitions) and message replay (duplicate delivery).
type network struct {
	replicas map[string]*Counter
	blocked  map[[2]string]bool
	replays  int // extra duplicate deliveries per message
}

func newNetwork(replays int, ids ...string) *network {
	n := &network{
		replicas: make(map[string]*Counter),
		blocked:  make(map[[2]string]bool),
		replays:  replays,
	}
	for _, id := range ids {
		n.replicas[id] = New(id, "authority")
	}
	return n
}

func (n *network) partition(groupA, groupB []string) {
	for _, a := range groupA {
		for _, b := range groupB {
			n.blocked[[2]string{a, b}] = true
			n.blocked[[2]string{b, a}] = true
		}
	}
}

func (n *network) heal() { n.blocked = make(map[[2]string]bool) }

// gossip runs rounds of all-pairs snapshot exchange until no replica
// changes state, or reports failure after maxRounds.
func (n *network) gossip(t *testing.T) {
	t.Helper()
	const maxRounds = 20
	for round := 0; round < maxRounds; round++ {
		changed := false
		for _, src := range n.replicas {
			snap := src.Snapshot()
			for _, dst := range n.replicas {
				if dst.replicaID == src.replicaID || n.blocked[[2]string{src.replicaID, dst.replicaID}] {
					continue
				}
				for i := 0; i <= n.replays; i++ { // replay duplicates
					if dst.Merge(snap) {
						changed = true
					}
				}
			}
		}
		if !changed {
			return
		}
	}
	t.Fatalf("gossip did not converge within %d rounds", maxRounds)
}

// ledger records issued operations per epoch to audit conservation.
type ledger struct {
	inc map[uint64]uint64
	dec map[uint64]uint64
}

func newLedger() *ledger {
	return &ledger{inc: make(map[uint64]uint64), dec: make(map[uint64]uint64)}
}

func (l *ledger) incOp(epoch uint64, n uint64) { l.inc[epoch] += n }
func (l *ledger) decOp(epoch uint64, n uint64) { l.dec[epoch] += n }

// checkConservation verifies that for every epoch, every replica's merged
// components sum exactly to the operations issued in that epoch.
func (l *ledger) checkConservation(t *testing.T, n *network) {
	t.Helper()
	epochs := make(map[uint64]struct{})
	for e := range l.inc {
		epochs[e] = struct{}{}
	}
	for e := range l.dec {
		epochs[e] = struct{}{}
	}
	for id, r := range n.replicas {
		for epoch := range epochs {
			want := int64(l.inc[epoch]) - int64(l.dec[epoch])
			if got := r.EpochSum(epoch); got != want {
				t.Errorf("replica %s epoch %d: net = %d, want %d (conservation violated)", id, epoch, got, want)
			}
		}
	}
}

// checkConvergence verifies all replicas agree on epoch, value, and every
// per-epoch sum.
func checkConvergence(t *testing.T, n *network) {
	t.Helper()
	var ref *Counter
	for _, r := range n.replicas {
		ref = r
		break
	}
	for id, r := range n.replicas {
		if r.Epoch() != ref.Epoch() {
			t.Errorf("replica %s epoch %d, want %d (diverged)", id, r.Epoch(), ref.Epoch())
		}
		if r.Value() != ref.Value() {
			t.Errorf("replica %s value %d, want %d (diverged)", id, r.Value(), ref.Value())
		}
		for _, e := range ref.Epochs() {
			if r.EpochSum(e) != ref.EpochSum(e) {
				t.Errorf("replica %s epoch %d sum %d, want %d (diverged)", id, e, r.EpochSum(e), ref.EpochSum(e))
			}
		}
	}
}

func TestEpochConservation(t *testing.T) {
	net := newNetwork(0, "A", "B", "C")
	led := newLedger()

	ops := []struct {
		id    string
		inc   uint64
		dec   uint64
	}{
		{"A", 10, 2},
		{"B", 5, 1},
		{"C", 0, 4},
	}
	for _, op := range ops {
		net.replicas[op.id].Inc(op.inc)
		net.replicas[op.id].Dec(op.dec)
		led.incOp(0, op.inc)
		led.decOp(0, op.dec)
	}

	net.gossip(t)
	led.checkConservation(t, net)
	checkConvergence(t, net)

	if got, want := net.replicas["A"].Value(), int64(8); got != want {
		t.Fatalf("value = %d, want %d", got, want)
	}
}

func TestResetAuthorization(t *testing.T) {
	c := New("A", "authority")
	c.Inc(7)

	if c.Reset(1, "mallory") {
		t.Error("reset from non-authority issuer must be rejected")
	}
	if c.Epoch() != 0 || c.Value() != 7 {
		t.Errorf("rejected reset changed state: epoch %d value %d", c.Epoch(), c.Value())
	}
	if c.Reset(0, "authority") {
		t.Error("reset with non-greater epoch must be rejected")
	}
	if !c.Reset(1, "authority") {
		t.Error("authoritative reset with larger epoch must be applied")
	}
	if c.Epoch() != 1 || c.Value() != 0 {
		t.Errorf("after reset: epoch %d value %d, want epoch 1 value 0", c.Epoch(), c.Value())
	}
	if c.Reset(1, "authority") {
		t.Error("reset with equal epoch must be rejected")
	}
	if got := c.EpochSum(0); got != 7 {
		t.Errorf("old epoch components must be retained for audit, got %d want 7", got)
	}
}

func TestLateOldEpochMessageNoResurrect(t *testing.T) {
	net := newNetwork(0, "A", "B")
	led := newLedger()

	net.replicas["A"].Inc(100)
	led.incOp(0, 100)
	stale := net.replicas["A"].Snapshot() // epoch-0 snapshot captured pre-reset

	// Authority resets; both replicas move to epoch 1 and count fresh ops.
	for _, r := range net.replicas {
		if !r.Reset(1, "authority") {
			t.Fatal("authoritative reset rejected")
		}
	}
	net.replicas["A"].Inc(5)
	net.replicas["B"].Dec(2)
	led.incOp(1, 5)
	led.decOp(1, 2)
	net.gossip(t)

	if got := net.replicas["B"].Value(); got != 3 {
		t.Fatalf("value before stale delivery = %d, want 3", got)
	}

	// The stale epoch-0 snapshot arrives late at B (replayed twice).
	net.replicas["B"].Merge(stale)
	net.replicas["B"].Merge(stale)

	if got := net.replicas["B"].Value(); got != 3 {
		t.Errorf("late epoch-0 message resurrected old counts: value = %d, want 3", got)
	}
	if got := net.replicas["B"].Epoch(); got != 1 {
		t.Errorf("late message regressed epoch to %d, want 1", got)
	}
	if got := net.replicas["B"].EpochSum(0); got != 100 {
		t.Errorf("old epoch sum = %d, want 100 (history preserved, not counted)", got)
	}
	led.checkConservation(t, net)
}

func TestPartitionHealConvergence(t *testing.T) {
	net := newNetwork(2, "A", "B", "C", "D", "E") // replay every message twice
	led := newLedger()

	net.partition([]string{"A", "B"}, []string{"C", "D", "E"})

	// Both sides operate independently during the partition.
	net.replicas["A"].Inc(10)
	net.replicas["B"].Dec(3)
	led.incOp(0, 10)
	led.decOp(0, 3)
	net.replicas["C"].Inc(4)
	net.replicas["D"].Inc(6)
	net.replicas["E"].Dec(1)
	led.incOp(0, 10)
	led.decOp(0, 1)

	net.gossip(t) // converges within each partition only

	if got := net.replicas["A"].Value(); got != 7 {
		t.Fatalf("partition {A,B} value = %d, want 7", got)
	}
	if got := net.replicas["C"].Value(); got != 9 {
		t.Fatalf("partition {C,D,E} value = %d, want 9", got)
	}

	net.heal()
	net.gossip(t)

	led.checkConservation(t, net)
	checkConvergence(t, net)
	if got := net.replicas["A"].Value(); got != 16 {
		t.Fatalf("post-heal value = %d, want 16", got)
	}
}

func TestResetDuringPartitionThenHeal(t *testing.T) {
	net := newNetwork(1, "A", "B", "C")
	led := newLedger()

	net.replicas["A"].Inc(50)
	led.incOp(0, 50)
	net.gossip(t)

	net.partition([]string{"A"}, []string{"B", "C"})

	// Reset originates on A's side; B keeps counting in epoch 0 unaware.
	if !net.replicas["A"].Reset(1, "authority") {
		t.Fatal("authoritative reset rejected")
	}
	net.replicas["A"].Inc(8)
	led.incOp(1, 8)
	net.replicas["B"].Inc(30) // late epoch-0 activity on the other side
	led.incOp(0, 30)
	net.gossip(t)

	if got := net.replicas["B"].Value(); got != 80 {
		t.Fatalf("B still in epoch 0: value = %d, want 80", got)
	}

	net.heal()
	net.gossip(t)

	// After healing, everyone adopts epoch 1; B's late epoch-0 increments
	// are preserved in history but must not leak into the new epoch.
	led.checkConservation(t, net)
	checkConvergence(t, net)
	for id, r := range net.replicas {
		if r.Epoch() != 1 {
			t.Errorf("replica %s epoch = %d, want 1", id, r.Epoch())
		}
		if got := r.Value(); got != 8 {
			t.Errorf("replica %s value = %d, want 8 (old epoch must not resurrect)", id, got)
		}
		if got := r.EpochSum(0); got != 80 {
			t.Errorf("replica %s epoch-0 sum = %d, want 80 (history conserved)", id, got)
		}
	}
}

func TestReplayIdempotent(t *testing.T) {
	a, b := New("A", "authority"), New("B", "authority")
	a.Inc(9)
	a.Dec(4)
	snap := a.Snapshot()

	if !b.Merge(snap) {
		t.Fatal("first merge should report a change")
	}
	for i := 0; i < 5; i++ {
		if b.Merge(snap) {
			t.Fatalf("replay %d reported a change; merge must be idempotent", i)
		}
	}
	if got := b.Value(); got != 5 {
		t.Fatalf("value after replays = %d, want 5", got)
	}

	// Mutating the snapshot afterwards must not affect already-merged state.
	snap.Inc[0]["A"] = 999
	if got := b.Value(); got != 5 {
		t.Fatalf("snapshot aliasing leaked into replica: value = %d, want 5", got)
	}
}

func TestMultiEpochConservation(t *testing.T) {
	net := newNetwork(3, "A", "B", "C", "D")
	led := newLedger()

	for epoch := uint64(0); epoch < 4; epoch++ {
		for i, id := range []string{"A", "B", "C", "D"} {
			inc := uint64(epoch+1) * uint64(i+2)
			dec := uint64(i)
			net.replicas[id].Inc(inc)
			net.replicas[id].Dec(dec)
			led.incOp(epoch, inc)
			led.decOp(epoch, dec)
		}
		net.gossip(t)
		if epoch < 3 {
			for _, r := range net.replicas {
				if !r.Reset(epoch+1, "authority") {
					t.Fatalf("reset to epoch %d rejected", epoch+1)
				}
			}
		}
	}

	led.checkConservation(t, net)
	checkConvergence(t, net)

	// Spot-check per-epoch conservation with explicit expectations.
	wantSums := map[uint64]int64{0: 8, 1: 22, 2: 36, 3: 50}
	for id, r := range net.replicas {
		for epoch, want := range wantSums {
			if got := r.EpochSum(epoch); got != want {
				t.Errorf("replica %s epoch %d sum = %d, want %d", id, epoch, got, want)
			}
		}
	}
	if got := net.replicas["A"].Value(); got != 50 {
		t.Errorf("final value = %d, want 50 (current epoch only)", got)
	}
	fmt.Println("per-epoch sums verified:", wantSums)
}
