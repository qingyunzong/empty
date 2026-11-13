package dataeng

import (
	"errors"
	"testing"
	"time"
)

// fakeClock is a test-only controllable time source. The package under test
// never reads the wall clock; every timestamp used in an assertion is a
// literal written in this file.
type fakeClock struct {
	now time.Time
}

func (f *fakeClock) Now() time.Time {
	return f.now
}

func (f *fakeClock) Advance(d time.Duration) {
	f.now = f.now.Add(d)
}

func newTestTracker() (*Tracker, *fakeClock) {
	clock := &fakeClock{
		now: time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC),
	}
	return NewTracker(clock, 5*time.Second), clock
}

func TestReserveMonotonicAndNeverFillsGap(t *testing.T) {
	tracker, _ := newTestTracker()

	// Every reservation hands out the next strictly increasing sequence. The
	// literals below are the expected contract, not values read back from the
	// tracker.
	if got := tracker.Reserve(); got != 1 {
		t.Fatalf("first reserve: got %d, want 1", got)
	}
	if got := tracker.Reserve(); got != 2 {
		t.Fatalf("second reserve: got %d, want 2", got)
	}
	if got := tracker.Reserve(); got != 3 {
		t.Fatalf("third reserve: got %d, want 3", got)
	}

	// Slot 2 is abandoned: never committed. Committing 1 and 3 must not reuse
	// sequence 2, and a later reservation must be 4 rather than filling the gap.
	if err := tracker.Commit(1); err != nil {
		t.Fatalf("commit slot 1: %v", err)
	}
	if err := tracker.Commit(3); err != nil {
		t.Fatalf("commit slot 3: %v", err)
	}
	if got := tracker.Reserve(); got != 4 {
		t.Fatalf("reserve after gap: got %d, want 4", got)
	}

	got := tracker.Poll()
	want := []Dispatch{
		{Sequence: 1, Generation: 1},
		{Sequence: 3, Generation: 1},
	}
	assertDispatches(t, got, want)
}

func TestOnlyCommittedSlotsDispatch(t *testing.T) {
	tracker, _ := newTestTracker()

	// Reserve three slots but commit only slot 2. Uncommitted slots, including
	// the lower-sequence gap at 1, must never be returned.
	tracker.Reserve()
	tracker.Reserve()
	tracker.Reserve()
	if err := tracker.Commit(2); err != nil {
		t.Fatalf("commit slot 2: %v", err)
	}

	got := tracker.Poll()
	want := []Dispatch{{Sequence: 2, Generation: 1}}
	assertDispatches(t, got, want)

	// Slot 2 is now in flight and has not timed out, so polling again yields
	// nothing while slots 1 and 3 remain uncommitted.
	assertDispatches(t, tracker.Poll(), []Dispatch{})
}

func TestStaleAcknowledgementIsIgnored(t *testing.T) {
	tracker, clock := newTestTracker()

	tracker.Reserve()
	if err := tracker.Commit(1); err != nil {
		t.Fatalf("commit slot 1: %v", err)
	}
	assertDispatches(t, tracker.Poll(), []Dispatch{
		{Sequence: 1, Generation: 1},
	})

	// Before the timeout the slot is still in flight and must not be redispatched.
	clock.Advance(4 * time.Second)
	assertDispatches(t, tracker.Poll(), []Dispatch{})

	// At exactly the timeout, redispatch keeps the sequence and bumps the
	// generation from 1 to 2.
	clock.Advance(1 * time.Second)
	assertDispatches(t, tracker.Poll(), []Dispatch{
		{Sequence: 1, Generation: 2},
	})

	// An acknowledgement carrying the old generation 1 is stale: it must error
	// and leave the slot in flight.
	if err := tracker.Ack(1, 1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale ack: got %v, want ErrStaleGeneration", err)
	}

	// Proof the stale ack changed nothing: another timeout produces generation
	// 3 on the same sequence instead of an empty poll.
	clock.Advance(5 * time.Second)
	assertDispatches(t, tracker.Poll(), []Dispatch{
		{Sequence: 1, Generation: 3},
	})

	// The current generation acknowledges successfully; afterwards the slot is
	// never dispatched again.
	if err := tracker.Ack(1, 3); err != nil {
		t.Fatalf("matching ack: %v", err)
	}
	clock.Advance(5 * time.Second)
	assertDispatches(t, tracker.Poll(), []Dispatch{})

	// Any late acknowledgement after completion is rejected rather than
	// resurrecting the slot.
	if err := tracker.Ack(1, 2); !errors.Is(err, ErrAlreadyAcknowledged) {
		t.Fatalf("late ack after completion: got %v, want ErrAlreadyAcknowledged", err)
	}
}

func TestRedispatchKeepsSequenceUntilAcknowledged(t *testing.T) {
	tracker, clock := newTestTracker()

	tracker.Reserve()
	tracker.Reserve()
	if err := tracker.Commit(1); err != nil {
		t.Fatalf("commit slot 1: %v", err)
	}
	if err := tracker.Commit(2); err != nil {
		t.Fatalf("commit slot 2: %v", err)
	}

	assertDispatches(t, tracker.Poll(), []Dispatch{
		{Sequence: 1, Generation: 1},
		{Sequence: 2, Generation: 1},
	})

	// Only slot 1 is acknowledged. After the timeout slot 2 is redispatched on
	// the same sequence with generation 2; slot 1 stays finished.
	if err := tracker.Ack(1, 1); err != nil {
		t.Fatalf("ack slot 1: %v", err)
	}
	clock.Advance(5 * time.Second)
	assertDispatches(t, tracker.Poll(), []Dispatch{
		{Sequence: 2, Generation: 2},
	})

	// Acknowledging the previous attempt of slot 2 is stale.
	if err := tracker.Ack(2, 1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale ack slot 2: got %v, want ErrStaleGeneration", err)
	}

	// A generation that was never issued is reported separately.
	if err := tracker.Ack(2, 9); !errors.Is(err, ErrUnknownGeneration) {
		t.Fatalf("future ack slot 2: got %v, want ErrUnknownGeneration", err)
	}

	if err := tracker.Ack(2, 2); err != nil {
		t.Fatalf("matching ack slot 2: %v", err)
	}
	clock.Advance(5 * time.Second)
	assertDispatches(t, tracker.Poll(), []Dispatch{})
}

func TestRejectsUnknownAndUndispatchedSlots(t *testing.T) {
	tracker, _ := newTestTracker()

	if err := tracker.Commit(99); !errors.Is(err, ErrUnknownSlot) {
		t.Fatalf("commit unknown slot: got %v, want ErrUnknownSlot", err)
	}
	if err := tracker.Ack(99, 1); !errors.Is(err, ErrUnknownSlot) {
		t.Fatalf("ack unknown slot: got %v, want ErrUnknownSlot", err)
	}

	// A reserved but uncommitted slot cannot be acknowledged because it was
	// never dispatched.
	tracker.Reserve()
	if err := tracker.Ack(1, 1); !errors.Is(err, ErrNotDispatched) {
		t.Fatalf("ack undispatched slot: got %v, want ErrNotDispatched", err)
	}

	// Double commit is rejected instead of silently moving the lifecycle back.
	if err := tracker.Commit(1); err != nil {
		t.Fatalf("first commit: %v", err)
	}
	if err := tracker.Commit(1); !errors.Is(err, ErrNotCommitted) {
		t.Fatalf("double commit: got %v, want ErrNotCommitted", err)
	}
}

func TestAcknowledgementIsIdempotentForSameGeneration(t *testing.T) {
	tracker, _ := newTestTracker()

	tracker.Reserve()
	if err := tracker.Commit(1); err != nil {
		t.Fatalf("commit slot 1: %v", err)
	}
	tracker.Poll()

	if err := tracker.Ack(1, 1); err != nil {
		t.Fatalf("first ack: %v", err)
	}
	// Re-delivering the same acknowledgement (for example a retried caller) is
	// harmless.
	if err := tracker.Ack(1, 1); err != nil {
		t.Fatalf("duplicate ack: %v", err)
	}
	assertDispatches(t, tracker.Poll(), []Dispatch{})
}

func assertDispatches(t *testing.T, got, want []Dispatch) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("dispatch count: got %d, want %d (got %v, want %v)", len(got), len(want), got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("dispatch at index %d: got %+v, want %+v", index, got[index], want[index])
		}
	}
}
