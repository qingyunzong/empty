package dataeng

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newTestSub(clk *fakeClock) *Subscription {
	return NewSubscription(
		WithAckDeadline(10*time.Second),
		WithClock(clk.now),
	)
}

func pullOne(t *testing.T, s *Subscription) *Delivery {
	t.Helper()
	ds := s.Pull(context.Background(), 10)
	if len(ds) != 1 {
		t.Fatalf("expected 1 delivery, got %d", len(ds))
	}
	return ds[0]
}

func TestSingleActivePrefixPerOrderingKey(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "a1", OrderingKey: "k"})
	s.Publish(Message{ID: "a2", OrderingKey: "k"})

	d1 := pullOne(t, s)
	if d1.Message().ID != "a1" {
		t.Fatalf("head should be a1, got %s", d1.Message().ID)
	}
	if got := len(s.Pull(context.Background(), 10)); got != 0 {
		t.Fatalf("key k must have only one active prefix, got %d extra deliveries", got)
	}
	if err := d1.Ack(); err != nil {
		t.Fatalf("ack a1: %v", err)
	}
	d2 := pullOne(t, s)
	if d2.Message().ID != "a2" {
		t.Fatalf("after ack, next prefix should be a2, got %s", d2.Message().ID)
	}
}

func TestLeaseExpiryRedeliversAndFencesOldHolder(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "m1", OrderingKey: "k"})

	d1 := pullOne(t, s)
	clk.advance(11 * time.Second) // past the 10s ack deadline

	d2 := pullOne(t, s) // subscription redelivery
	if d2.Message().ID != "m1" || d2.Message().Attempt != 2 {
		t.Fatalf("expected redelivery of m1 attempt 2, got %+v", d2.Message())
	}
	if err := d1.Ack(); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("old holder must not commit after lease loss, got %v", err)
	}
	if err := d1.Extend(time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("old holder must not extend after lease loss, got %v", err)
	}
	if err := d2.Ack(); err != nil {
		t.Fatalf("new holder commits: %v", err)
	}
	if s.Pending() != 0 {
		t.Fatalf("expected no pending messages, got %d", s.Pending())
	}
}

func TestNackTriggersImmediateRedelivery(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "m1", OrderingKey: "k"})
	s.Publish(Message{ID: "m2", OrderingKey: "k"})

	d1 := pullOne(t, s)
	if err := d1.Nack(); err != nil {
		t.Fatalf("nack: %v", err)
	}
	d2 := pullOne(t, s)
	if d2.Message().ID != "m1" || d2.Message().Attempt != 2 {
		t.Fatalf("nacked head must be redelivered first, got %+v", d2.Message())
	}
	if err := d1.Ack(); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale handle after nack must be fenced, got %v", err)
	}
}

func TestModifyAckDeadlineExtendsLease(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "m1", OrderingKey: "k"})

	d := pullOne(t, s)
	clk.advance(9 * time.Second)
	if err := d.Extend(20 * time.Second); err != nil {
		t.Fatalf("extend: %v", err)
	}
	clk.advance(15 * time.Second) // past original deadline, within extension
	if got := len(s.Pull(context.Background(), 10)); got != 0 {
		t.Fatalf("extended lease must not be redelivered, got %d", got)
	}
	if err := d.Ack(); err != nil {
		t.Fatalf("ack within extended deadline: %v", err)
	}
}

func TestUnorderedMessagesProgressIndependently(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "u1"})
	s.Publish(Message{ID: "u2"})
	s.Publish(Message{ID: "u3"})

	ds := s.Pull(context.Background(), 10)
	if len(ds) != 3 {
		t.Fatalf("unordered messages must lease independently, got %d", len(ds))
	}
	for _, d := range ds {
		if err := d.Ack(); err != nil {
			t.Fatalf("ack %s: %v", d.Message().ID, err)
		}
	}
	if s.Pending() != 0 {
		t.Fatalf("expected no pending, got %d", s.Pending())
	}
}

func TestRestorePreservesPerKeyPublishOrder(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "k1-a", OrderingKey: "k1"})
	s.Publish(Message{ID: "k1-b", OrderingKey: "k1"})
	s.Publish(Message{ID: "k1-c", OrderingKey: "k1"})

	d := pullOne(t, s) // k1-a (deterministic group order)
	if d.Message().ID != "k1-a" {
		t.Fatalf("expected k1-a head, got %s", d.Message().ID)
	}
	if err := d.Ack(); err != nil {
		t.Fatalf("ack k1-a: %v", err)
	}
	// Crash with k1-b leased in flight.
	inFlight := pullOne(t, s)
	if inFlight.Message().ID != "k1-b" {
		t.Fatalf("expected k1-b in flight, got %s", inFlight.Message().ID)
	}
	s.Publish(Message{ID: "k2-x", OrderingKey: "k2"})

	// Crash recovery: state is restored in place, fencing all live leases.
	s.RestoreFrom(s.Snapshot())
	if err := inFlight.Ack(); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("pre-recovery holder must not commit, got %v", err)
	}

	var got []string
	for {
		ds := s.Pull(context.Background(), 10)
		if len(ds) == 0 {
			break
		}
		for _, d := range ds {
			got = append(got, d.Message().ID)
			if err := d.Ack(); err != nil {
				t.Fatalf("ack %s: %v", d.Message().ID, err)
			}
		}
	}
	// k1-b (recovered from in-flight) precedes k1-c; k2-x is independent.
	want := []string{"k1-b", "k2-x", "k1-c"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	idx := map[string]int{}
	for i, id := range got {
		idx[id] = i
	}
	if idx["k1-b"] > idx["k1-c"] {
		t.Fatalf("per-key publish order violated: %v", got)
	}
	if s.Pending() != 0 {
		t.Fatalf("expected drained subscription, got %d pending", s.Pending())
	}
}

func TestAckedIDsSurviveSnapshot(t *testing.T) {
	clk := newFakeClock()
	s := newTestSub(clk)
	s.Publish(Message{ID: "m1", OrderingKey: "k"})
	if err := pullOne(t, s).Ack(); err != nil {
		t.Fatalf("ack: %v", err)
	}
	snap := s.Snapshot()
	if len(snap.Acked) != 1 || snap.Acked[0] != "m1" {
		t.Fatalf("snapshot acked = %v", snap.Acked)
	}
	r := Restore(snap, WithClock(clk.now))
	if r.Pending() != 0 {
		t.Fatalf("restored pending = %d", r.Pending())
	}
}
