package broadcastsim

import (
	"errors"
	"fmt"
	"testing"
)

func newTestCluster(t *testing.T) *Cluster {
	t.Helper()
	c, err := NewCluster(t.TempDir(), "n1", "n2", "n3")
	if err != nil {
		t.Fatalf("NewCluster: %v", err)
	}
	return c
}

func broadcastN(t *testing.T, c *Cluster, from string, count int) {
	t.Helper()
	for seq := 1; seq <= count; seq++ {
		if err := c.Broadcast(from, Message{Seq: seq, Payload: fmt.Sprintf("msg-%d", seq)}); err != nil {
			t.Fatalf("Broadcast seq %d: %v", seq, err)
		}
	}
}

func wantDelivered(t *testing.T, c *Cluster, count int) {
	t.Helper()
	for _, id := range c.NodeIDs() {
		got := c.Node(id).Delivered()
		if len(got) != count {
			t.Fatalf("node %s: delivered %d messages, want %d", id, len(got), count)
		}
		for i, m := range got {
			wantSeq := i + 1
			if m.Seq != wantSeq || m.Payload != fmt.Sprintf("msg-%d", wantSeq) {
				t.Fatalf("node %s: delivered[%d] = %+v, want seq %d", id, i, m, wantSeq)
			}
		}
	}
}

// TestOrderedDeliveryNoLoss: 3 messages broadcast on a perfect network are
// delivered by every node in numbered order, and the cluster verifies clean.
func TestOrderedDeliveryNoLoss(t *testing.T) {
	c := newTestCluster(t)
	broadcastN(t, c, "n1", 3)
	if err := c.FlushUntilIdle(20); err != nil {
		t.Fatalf("FlushUntilIdle: %v", err)
	}
	wantDelivered(t, c, 3)
	if err := c.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// TestOutOfOrderAndDuplicates: out-of-order messages are buffered until
// predecessors are delivered; duplicates are ignored.
func TestOutOfOrderAndDuplicates(t *testing.T) {
	n, err := NewNode("n1", t.TempDir())
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	// Seq 2 arrives first with majority acks: nothing may be delivered.
	for _, from := range []string{"n1", "n2", "n3"} {
		if err := n.ReceiveAck(from, Message{Seq: 2, Payload: "b"}); err != nil {
			t.Fatalf("ReceiveAck seq 2: %v", err)
		}
	}
	if got := n.Delivered(); len(got) != 0 {
		t.Fatalf("delivered %v before seq 1, want nothing", got)
	}
	// Duplicate acks for seq 1 must be idempotent.
	for i := 0; i < 3; i++ {
		if err := n.ReceiveAck("n1", Message{Seq: 1, Payload: "a"}); err != nil {
			t.Fatalf("duplicate ReceiveAck: %v", err)
		}
	}
	if got := n.Delivered(); len(got) != 0 {
		t.Fatalf("delivered %v with only one distinct ack, want nothing", got)
	}
	// Second distinct ack reaches majority: 1 and then buffered 2 deliver.
	if err := n.ReceiveAck("n2", Message{Seq: 1, Payload: "a"}); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	got := n.Delivered()
	if len(got) != 2 || got[0].Payload != "a" || got[1].Payload != "b" {
		t.Fatalf("delivered %v, want [a b]", got)
	}
}

// TestMajorityRequired: a single ack is not enough; delivery happens exactly
// when the second (majority) ack arrives.
func TestMajorityRequired(t *testing.T) {
	n, err := NewNode("n1", t.TempDir())
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	msg := Message{Seq: 1, Payload: "x"}
	if err := n.ReceiveAck("n1", msg); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	if got := n.Delivered(); len(got) != 0 {
		t.Fatalf("delivered %v with 1 ack, want majority of %d", got, Majority)
	}
	if err := n.ReceiveAck("n3", msg); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	if got := n.Delivered(); len(got) != 1 {
		t.Fatalf("delivered %v, want 1 message after majority", got)
	}
}

// TestPacketLossPendingRetained: dropped packets stay pending and are
// delivered once the network recovers.
func TestPacketLossPendingRetained(t *testing.T) {
	c := newTestCluster(t)
	broadcastN(t, c, "n1", 2)

	// Total loss: every packet is dropped and retained.
	c.Loss = func(Envelope) bool { return true }
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if c.Pending() == 0 {
		t.Fatal("lost packets were not retained in the pending queue")
	}
	wantDelivered(t, c, 0)

	// Partial loss: only packets to n3 get through.
	c.Loss = func(env Envelope) bool { return env.To != "n3" }
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if c.Pending() == 0 {
		t.Fatal("dropped packets to n1/n2 were not retained")
	}

	// Network recovers: everything is delivered in order.
	c.Loss = nil
	if err := c.FlushUntilIdle(20); err != nil {
		t.Fatalf("FlushUntilIdle: %v", err)
	}
	wantDelivered(t, c, 2)
	if err := c.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// TestRestartRecovery: a node restarted from the same directory recovers its
// acknowledgment records and delivered prefix.
func TestRestartRecovery(t *testing.T) {
	dir := t.TempDir()
	n, err := NewNode("n1", dir)
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	if err := n.ReceiveAck("n1", Message{Seq: 1, Payload: "a"}); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	if err := n.ReceiveAck("n2", Message{Seq: 1, Payload: "a"}); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	if err := n.ReceiveAck("n2", Message{Seq: 2, Payload: "b"}); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	if got := n.Delivered(); len(got) != 1 {
		t.Fatalf("before restart: delivered %v, want 1 message", got)
	}

	// Restart: replay the ack log from disk.
	n2, err := NewNode("n1", dir)
	if err != nil {
		t.Fatalf("NewNode after restart: %v", err)
	}
	got := n2.Delivered()
	if len(got) != 1 || got[0].Payload != "a" {
		t.Fatalf("after restart: delivered %v, want [a]", got)
	}
	if senders := n2.ackSenders(2); len(senders) != 1 || senders[0] != "n2" {
		t.Fatalf("after restart: acks for seq 2 = %v, want [n2]", senders)
	}

	// The recovered ack still counts toward majority after restart.
	if err := n2.ReceiveAck("n3", Message{Seq: 2, Payload: "b"}); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	if got := n2.Delivered(); len(got) != 2 || got[1].Payload != "b" {
		t.Fatalf("after restart: delivered %v, want [a b]", got)
	}
}

// TestConflictDetection: a different payload for an already-acked sequence
// number is rejected, in memory and after a restart.
func TestConflictDetection(t *testing.T) {
	dir := t.TempDir()
	n, err := NewNode("n1", dir)
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	if err := n.ReceiveAck("n1", Message{Seq: 1, Payload: "a"}); err != nil {
		t.Fatalf("ReceiveAck: %v", err)
	}
	err = n.ReceiveAck("n2", Message{Seq: 1, Payload: "DIFFERENT"})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("ReceiveAck conflicting payload: got %v, want ErrConflict", err)
	}

	// The conflict is still detected after a restart replays the log.
	n2, err := NewNode("n1", dir)
	if err != nil {
		t.Fatalf("NewNode after restart: %v", err)
	}
	if err := n2.ReceiveAck("n3", Message{Seq: 1, Payload: "DIFFERENT"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("after restart: got %v, want ErrConflict", err)
	}
}

// TestClusterConflictPropagates: a conflicting broadcast surfaces through
// the cluster flush.
func TestClusterConflictPropagates(t *testing.T) {
	c := newTestCluster(t)
	if err := c.Broadcast("n1", Message{Seq: 1, Payload: "a"}); err != nil {
		t.Fatalf("Broadcast: %v", err)
	}
	if err := c.FlushUntilIdle(20); err != nil {
		t.Fatalf("FlushUntilIdle: %v", err)
	}
	if err := c.Broadcast("n2", Message{Seq: 1, Payload: "CONFLICT"}); err != nil {
		t.Fatalf("Broadcast: %v", err)
	}
	if err := c.FlushUntilIdle(20); !errors.Is(err, ErrConflict) {
		t.Fatalf("FlushUntilIdle: got %v, want ErrConflict", err)
	}
}

// TestPrefixConsistencyAcrossNodes: with selective loss, nodes may deliver
// different length prefixes, but Verify guarantees they are consistent.
func TestPrefixConsistencyAcrossNodes(t *testing.T) {
	c := newTestCluster(t)
	broadcastN(t, c, "n1", 3)

	// Only n1 and n2 receive anything; packets to n3 stay pending.
	c.Loss = func(env Envelope) bool { return env.To == "n3" }
	for round := 0; round < 5; round++ {
		if err := c.Flush(); err != nil {
			t.Fatalf("Flush: %v", err)
		}
	}
	if got := len(c.Node("n3").Delivered()); got != 0 {
		t.Fatalf("n3 delivered %d messages with total loss, want 0", got)
	}
	if got := len(c.Node("n1").Delivered()); got != 3 {
		t.Fatalf("n1 delivered %d messages, want 3", got)
	}
	if err := c.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}

	// The network recovers: n3 catches up and the prefixes converge.
	c.Loss = nil
	if err := c.FlushUntilIdle(20); err != nil {
		t.Fatalf("FlushUntilIdle: %v", err)
	}
	wantDelivered(t, c, 3)
	if err := c.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}
