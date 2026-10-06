package shardsim

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func mustNotComplete(t *testing.T, what string, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
		t.Fatalf("%s completed unexpectedly", what)
	case <-time.After(50 * time.Millisecond):
	}
}

// Rebalance must drain the old holder's in-flight callback before granting
// the shard to the new holder, and OnRevoked must precede OnAssigned.
func TestRebalanceDrainsInflightBeforeGrant(t *testing.T) {
	c := NewCoordinator()
	oldHolder := NewScripted(ActBlock)
	newHolder := NewScripted()

	c.Assign(1, oldHolder)
	if got := c.Generation(1); got != 1 {
		t.Fatalf("generation = %d, want 1", got)
	}

	deliverDone := make(chan error, 1)
	go func() { deliverDone <- c.Deliver(1, Record{Offset: 7}) }()
	waitFor(t, "old holder to be in-flight", func() bool { return oldHolder.Calls() == 1 })

	rebalanced := make(chan struct{})
	go func() {
		c.Assign(1, newHolder)
		close(rebalanced)
	}()

	// The grant must wait while the old callback is still in flight.
	mustNotComplete(t, "rebalance", rebalanced)
	if got := len(newHolder.Assigned()); got != 0 {
		t.Fatalf("new holder assigned %d times before drain", got)
	}

	oldHolder.Release()
	<-rebalanced
	if err := <-deliverDone; err != nil {
		t.Fatalf("deliver: %v", err)
	}

	if got := c.Generation(1); got != 2 {
		t.Fatalf("generation = %d, want 2", got)
	}
	if got := oldHolder.Revoked(); !reflect.DeepEqual(got, []uint64{1}) {
		t.Fatalf("old holder revoked generations = %v, want [1]", got)
	}
	if got := newHolder.Assigned(); !reflect.DeepEqual(got, []uint64{2}) {
		t.Fatalf("new holder assigned generations = %v, want [2]", got)
	}
}

// An ack arriving from a revoked generation must not advance the live
// cursor; the new generation re-delivers and commits from its own acks.
func TestStaleAckDoesNotAdvanceCursor(t *testing.T) {
	c := NewCoordinator()
	oldHolder := NewScripted(ActBlock)
	newHolder := NewScripted(ActAck)

	c.Assign(0, oldHolder)
	staleDone := make(chan error, 1)
	go func() { staleDone <- c.Deliver(0, Record{Offset: 5}) }()
	waitFor(t, "old holder in-flight", func() bool { return oldHolder.Calls() == 1 })

	rebalanced := make(chan struct{})
	go func() {
		c.Assign(0, newHolder)
		close(rebalanced)
	}()
	mustNotComplete(t, "rebalance", rebalanced)

	// The old generation's callback returns and acks offset 5, but its
	// generation is already revoked.
	oldHolder.Release()
	<-rebalanced
	if err := <-staleDone; err != nil {
		t.Fatalf("stale deliver: %v", err)
	}

	if _, ok := c.Cursor(0); ok {
		t.Fatal("stale ack advanced the new generation's cursor")
	}
	ledger := c.Ledger(0)
	if len(ledger) != 1 || ledger[0] != (Entry{Offset: 5, Generation: 1, Outcome: StaleAck}) {
		t.Fatalf("ledger = %+v, want one stale-ack entry for gen 1", ledger)
	}

	// The new generation re-delivers the same offset and commits it.
	if err := c.Deliver(0, Record{Offset: 5}); err != nil {
		t.Fatalf("redeliver: %v", err)
	}
	if cur, ok := c.Cursor(0); !ok || cur != 5 {
		t.Fatalf("cursor = %d,%v, want 5,true", cur, ok)
	}
}

// Cancel drains in-flight callbacks, then leaves the shard without a holder.
func TestCancelDrainsAndRejectsDelivery(t *testing.T) {
	c := NewCoordinator()
	holder := NewScripted(ActBlock)
	c.Assign(2, holder)

	deliverDone := make(chan error, 1)
	go func() { deliverDone <- c.Deliver(2, Record{Offset: 3}) }()
	waitFor(t, "holder in-flight", func() bool { return holder.Calls() == 1 })

	cancelled := make(chan struct{})
	go func() {
		c.Cancel(2)
		close(cancelled)
	}()
	mustNotComplete(t, "cancel", cancelled)

	// While draining, new deliveries are rejected.
	if err := c.Deliver(2, Record{Offset: 4}); !errors.Is(err, ErrRevoking) {
		t.Fatalf("deliver during drain: %v, want ErrRevoking", err)
	}

	holder.Release()
	<-cancelled
	if err := <-deliverDone; err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got := holder.Revoked(); !reflect.DeepEqual(got, []uint64{1}) {
		t.Fatalf("revoked generations = %v, want [1]", got)
	}
	if err := c.Deliver(2, Record{Offset: 5}); !errors.Is(err, ErrNoHolder) {
		t.Fatalf("deliver after cancel: %v, want ErrNoHolder", err)
	}
	// The drained ack belonged to the revoked generation: no cursor.
	if _, ok := c.Cursor(2); ok {
		t.Fatal("cursor advanced by a revoked generation's ack")
	}
	ledger := c.Ledger(2)
	if len(ledger) != 1 || ledger[0].Outcome != StaleAck {
		t.Fatalf("ledger = %+v, want one stale-ack entry", ledger)
	}
}

// The ledger tracks every delivery per shard with its outcome, and Report
// renders a per-shard account.
func TestPerShardLedgerAndReport(t *testing.T) {
	c := NewCoordinator()
	c.Assign(0, NewScripted(ActAck, ActDrop, ActAck))
	c.Assign(1, NewScripted(ActAck))

	for _, off := range []int64{1, 2, 3} {
		if err := c.Deliver(0, Record{Offset: off}); err != nil {
			t.Fatalf("deliver shard 0: %v", err)
		}
	}
	if err := c.Deliver(1, Record{Offset: 9}); err != nil {
		t.Fatalf("deliver shard 1: %v", err)
	}

	want0 := []Entry{
		{Offset: 1, Generation: 1, Outcome: Acked},
		{Offset: 2, Generation: 1, Outcome: Dropped},
		{Offset: 3, Generation: 1, Outcome: Acked},
	}
	if got := c.Ledger(0); !reflect.DeepEqual(got, want0) {
		t.Fatalf("shard 0 ledger = %+v, want %+v", got, want0)
	}
	want1 := []Entry{{Offset: 9, Generation: 1, Outcome: Acked}}
	if got := c.Ledger(1); !reflect.DeepEqual(got, want1) {
		t.Fatalf("shard 1 ledger = %+v, want %+v", got, want1)
	}

	if cur, ok := c.Cursor(0); !ok || cur != 3 {
		t.Fatalf("shard 0 cursor = %d,%v, want 3,true", cur, ok)
	}

	report := c.Report()
	for _, want := range []string{
		"shard 0 generation=1 cursor=3",
		"offset=2 gen=1 dropped",
		"shard 1 generation=1 cursor=9",
	} {
		if !strings.Contains(report, want) {
			t.Fatalf("report missing %q:\n%s", want, report)
		}
	}
}

// Acks never move the cursor backwards within a generation.
func TestCursorNeverRegresses(t *testing.T) {
	c := NewCoordinator()
	c.Assign(0, NewScripted())
	if err := c.Deliver(0, Record{Offset: 10}); err != nil {
		t.Fatal(err)
	}
	if err := c.Deliver(0, Record{Offset: 4}); err != nil {
		t.Fatal(err)
	}
	if cur, ok := c.Cursor(0); !ok || cur != 10 {
		t.Fatalf("cursor = %d,%v, want 10,true", cur, ok)
	}
}
