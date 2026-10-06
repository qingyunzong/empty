package sim

import (
	"sync"
	"testing"
	"time"
)

// recorder collects the event stream for enumeration in assertions.
type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) listen(e Event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) kinds() []EventKind {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]EventKind, len(r.events))
	for i, e := range r.events {
		out[i] = e.Kind
	}
	return out
}

func (r *recorder) snapshot() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Event, len(r.events))
	copy(out, r.events)
	return out
}

func requireKinds(t *testing.T, got []EventKind, want ...EventKind) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("event kinds = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("event kinds = %v, want %v", got, want)
		}
	}
}

// TestDeliverAckLedger covers the happy path: assignment, delivery ledger
// per shard, and cursor advancement through acks.
func TestDeliverAckLedger(t *testing.T) {
	rec := &recorder{}
	s := New(2, nil, rec.listen)

	gen := s.Assign(0, "alice")
	if gen != 1 {
		t.Fatalf("generation = %d, want 1", gen)
	}
	s.Assign(1, "bob")

	if !s.Deliver(0, "m0") || !s.Deliver(0, "m1") || !s.Deliver(1, "x0") {
		t.Fatal("deliveries to active shards must succeed")
	}

	ledger0 := s.Ledger(0)
	if len(ledger0) != 2 || ledger0[0].Payload != "m0" || ledger0[1].Payload != "m1" {
		t.Fatalf("shard 0 ledger = %+v", ledger0)
	}
	if ledger0[0].Offset != 0 || ledger0[1].Offset != 1 {
		t.Fatalf("ledger offsets = %d,%d, want 0,1", ledger0[0].Offset, ledger0[1].Offset)
	}
	if ledger0[0].Holder != "alice" || ledger0[0].Generation != 1 {
		t.Fatalf("ledger entry stamped with %+v", ledger0[0].Delivery)
	}
	if len(s.Ledger(1)) != 1 {
		t.Fatalf("shard 1 ledger = %+v", s.Ledger(1))
	}

	if !s.Ack(0, "alice", 1, 0) || !s.Ack(0, "alice", 1, 1) {
		t.Fatal("acks from the current generation must be accepted")
	}
	if got := s.Cursor(0); got != 2 {
		t.Fatalf("cursor = %d, want 2", got)
	}
	if !s.Ledger(0)[0].Acked || !s.Ledger(0)[1].Acked || s.Ledger(1)[0].Acked {
		t.Fatalf("ledger ack flags wrong: %+v / %+v", s.Ledger(0), s.Ledger(1))
	}

	requireKinds(t, rec.kinds(),
		EventAssigned, EventAssigned, EventAcked, EventAcked)
}

// TestRebalanceWaitsForInflight uses a controlled callback that blocks
// until the test releases it, proving the new grant happens only after
// the old holder's in-flight callback finishes.
func TestRebalanceWaitsForInflight(t *testing.T) {
	rec := &recorder{}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	cb := func(Delivery) {
		once.Do(func() { close(entered) })
		<-release
	}
	s := New(1, cb, rec.listen)
	s.Assign(0, "old")

	deliverDone := make(chan bool, 1)
	go func() { deliverDone <- s.Deliver(0, "in-flight") }()
	<-entered // callback is now in-flight

	rebalanced := make(chan uint64, 1)
	go func() { rebalanced <- s.Rebalance(0, "new") }()

	// While the old callback is blocked, the rebalance must not grant.
	select {
	case gen := <-rebalanced:
		t.Fatalf("rebalance granted gen %d before in-flight callback drained", gen)
	case <-time.After(50 * time.Millisecond):
	}
	if holder, active := s.Holder(0); active {
		t.Fatalf("shard still active under %q during drain", holder)
	}

	close(release)
	if !<-deliverDone {
		t.Fatal("delivery started while active must complete")
	}
	if gen := <-rebalanced; gen != 2 {
		t.Fatalf("new generation = %d, want 2", gen)
	}
	if holder, active := s.Holder(0); holder != "new" || !active {
		t.Fatalf("holder = %q active=%v, want new/true", holder, active)
	}

	requireKinds(t, rec.kinds(),
		EventAssigned, EventRevoked, EventDrained, EventAssigned)

	// The drained event must name the old generation and holder.
	drained := rec.snapshot()[2]
	if drained.Generation != 1 || drained.Holder != "old" {
		t.Fatalf("drained event = %+v", drained)
	}
}

// TestStaleAckCannotAdvanceNewCursor delivers under generation 1,
// rebalances, then proves the old holder's ack is rejected and the new
// generation's cursor stays put.
func TestStaleAckCannotAdvanceNewCursor(t *testing.T) {
	rec := &recorder{}
	s := New(1, nil, rec.listen)
	s.Assign(0, "old")
	s.Deliver(0, "m0")
	s.Deliver(0, "m1")

	s.Rebalance(0, "new")
	s.Deliver(0, "n0")

	// Old holder replays its acks against the new generation.
	if s.Ack(0, "old", 1, 1) {
		t.Fatal("stale-generation ack must be rejected")
	}
	if got := s.Cursor(0); got != 0 {
		t.Fatalf("cursor advanced to %d via stale ack", got)
	}
	// Right holder, wrong generation is also stale.
	if s.Ack(0, "new", 1, 0) {
		t.Fatal("wrong-generation ack from current holder must be rejected")
	}
	// The new generation acks its own delivery normally.
	if !s.Ack(0, "new", 2, 2) {
		t.Fatal("current-generation ack must be accepted")
	}
	if got := s.Cursor(0); got != 3 {
		t.Fatalf("cursor = %d, want 3", got)
	}
	// The old entries stay unacked in the ledger.
	ledger := s.Ledger(0)
	if ledger[0].Acked || ledger[1].Acked || !ledger[2].Acked {
		t.Fatalf("ledger ack flags = %+v", ledger)
	}

	requireKinds(t, rec.kinds(),
		EventAssigned, EventRevoked, EventDrained, EventAssigned,
		EventStaleAck, EventStaleAck, EventAcked)
}

// TestCancelDrainsAndDeactivates proves cancellation waits for in-flight
// callbacks, leaves the shard unassigned, and rejects further traffic.
func TestCancelDrainsAndDeactivates(t *testing.T) {
	rec := &recorder{}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	cb := func(Delivery) {
		once.Do(func() { close(entered) })
		<-release
	}
	s := New(1, cb, rec.listen)
	s.Assign(0, "worker")
	go s.Deliver(0, "m0")
	<-entered

	cancelled := make(chan struct{})
	go func() { s.Cancel(0); close(cancelled) }()

	select {
	case <-cancelled:
		t.Fatal("cancel returned before in-flight callback drained")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	<-cancelled

	if holder, active := s.Holder(0); active || holder != "" {
		t.Fatalf("holder = %q active=%v after cancel", holder, active)
	}
	if s.Deliver(0, "late") {
		t.Fatal("delivery to cancelled shard must fail")
	}
	if s.Ack(0, "worker", 1, 0) {
		t.Fatal("ack after cancel must be rejected")
	}
	if got := s.Cursor(0); got != 0 {
		t.Fatalf("cursor = %d after cancel, want 0", got)
	}

	requireKinds(t, rec.kinds(),
		EventAssigned, EventRevoked, EventCancelled, EventStaleAck)
}

// TestConcurrentInflightDrain rebalances with several concurrent
// in-flight callbacks and checks every one is accounted for.
func TestConcurrentInflightDrain(t *testing.T) {
	rec := &recorder{}
	release := make(chan struct{})
	var inFlight sync.WaitGroup
	cb := func(Delivery) { <-release }
	s := New(1, cb, rec.listen)
	s.Assign(0, "old")

	const n = 8
	inFlight.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer inFlight.Done()
			s.Deliver(0, "m")
		}()
	}
	// Wait until all n callbacks are registered as in-flight.
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		n := s.shards[0].inflight
		s.mu.Unlock()
		if n == 8 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d callbacks in flight", n)
		}
		time.Sleep(time.Millisecond)
	}

	done := make(chan uint64, 1)
	go func() { done <- s.Rebalance(0, "new") }()
	select {
	case <-done:
		t.Fatal("rebalance completed with callbacks still in flight")
	case <-time.After(50 * time.Millisecond):
	}

	close(release)
	inFlight.Wait()
	if gen := <-done; gen != 2 {
		t.Fatalf("generation = %d, want 2", gen)
	}
	if got := len(s.Ledger(0)); got != n {
		t.Fatalf("ledger has %d entries, want %d", got, n)
	}
	requireKinds(t, rec.kinds(),
		EventAssigned, EventRevoked, EventDrained, EventAssigned)
}
