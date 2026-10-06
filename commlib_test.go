package commlib

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

type fixture struct {
	senderStore   *FaultyStore
	receiverStore *FaultyStore
	tx            *FlakyTransport
	sender        *Sender
	receiver      *Receiver
	ledger        *Ledger
}

func newFixture() *fixture {
	f := &fixture{
		senderStore:   NewFaultyStore(NewMemStore()),
		receiverStore: NewFaultyStore(NewMemStore()),
		ledger:        NewLedger(),
	}
	f.receiver = NewReceiver(f.receiverStore)
	f.tx = NewFlakyTransport(DirectTransport{R: f.receiver})
	f.sender = NewSender(f.senderStore, f.tx)
	return f
}

func (f *fixture) enqueue(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		msg := Message{ID: fmt.Sprintf("msg-%03d", i), Payload: []byte(fmt.Sprintf("payload-%d", i))}
		if err := f.sender.Enqueue(msg); err != nil {
			t.Fatalf("enqueue %s: %v", msg.ID, err)
		}
		if err := f.ledger.Record(msg); err != nil {
			t.Fatalf("ledger record %s: %v", msg.ID, err)
		}
	}
}

// drain pumps until the outbox is empty, injecting the scheduled faults
// before each round.
func (f *fixture) drain(t *testing.T, maxRounds int, faults func(round int)) {
	t.Helper()
	for round := 0; round < maxRounds; round++ {
		if faults != nil {
			faults(round)
		}
		if _, err := f.sender.PumpOnce(); err != nil {
			t.Fatalf("pump round %d: %v", round, err)
		}
		pending, err := f.sender.Pending()
		if err != nil {
			t.Fatalf("pending: %v", err)
		}
		if pending == 0 {
			return
		}
	}
	t.Fatalf("outbox did not drain within %d rounds", maxRounds)
}

// verifyAgainstLedger asserts the receiver's committed effects match the
// ledger exactly once per ID.
func (f *fixture) verifyAgainstLedger(t *testing.T) {
	t.Helper()
	effects, err := f.receiver.Effects()
	if err != nil {
		t.Fatalf("effects: %v", err)
	}
	ledger := f.ledger.Messages()
	if err := VerifyExactlyOnce(ledger, effects); err != nil {
		t.Fatal(err)
	}
	applied, err := f.receiver.AppliedCount()
	if err != nil {
		t.Fatalf("applied count: %v", err)
	}
	if applied != len(ledger) {
		t.Fatalf("applied count = %d, want exactly %d (one per ledger ID)", applied, len(ledger))
	}
}

// TestExactlyOnceUnderCombinedFaults injects persistent-write failures on
// both sides plus network partitions and lost acks, then checks the final
// effects against the complete message ledger.
func TestExactlyOnceUnderCombinedFaults(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 20)

	f.drain(t, 200, func(round int) {
		f.tx.SetPartition(false)
		switch round % 6 {
		case 0:
			f.tx.DropNextRequests(2) // requests lost in flight
		case 1:
			f.tx.LoseNextAcks(3) // applied, but ack lost -> retransmit
		case 2:
			f.receiverStore.FailNextBatchBeforeCommit(1) // receiver crash before commit
		case 3:
			f.receiverStore.FailNextBatchAfterCommit(1) // receiver crash after commit
		case 4:
			f.senderStore.FailNextBatchBeforeCommit(1) // sender crash retiring outbox record
		case 5:
			f.tx.SetPartition(true) // network down for one round
		}
	})

	f.verifyAgainstLedger(t)
}

// TestLostAcksAreRetried: every ack of the first round is lost. The receiver
// applies each message once; the sender retransmits and gets idempotent
// duplicate acks.
func TestLostAcksAreRetried(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 5)

	f.tx.LoseNextAcks(5)
	if _, err := f.sender.PumpOnce(); err != nil {
		t.Fatalf("pump: %v", err)
	}
	// All effects already applied despite the sender seeing only errors.
	f.verifyAgainstLedger(t)
	if pending, _ := f.sender.Pending(); pending != 5 {
		t.Fatalf("pending = %d, want 5 (acks were lost)", pending)
	}

	// Link recovers: retransmissions dedup and the outbox drains.
	f.drain(t, 10, nil)
	f.verifyAgainstLedger(t)
}

// TestReceiverCrashBeforeCommitLeavesNoPartialState: a failed batch must not
// leave a dedup mark without its effect.
func TestReceiverCrashBeforeCommitLeavesNoPartialState(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 1)

	f.receiverStore.FailNextBatchBeforeCommit(1)
	if _, err := f.sender.PumpOnce(); err != nil {
		t.Fatalf("pump: %v", err)
	}
	effects, err := f.receiver.Effects()
	if err != nil {
		t.Fatalf("effects: %v", err)
	}
	if len(effects) != 0 {
		t.Fatalf("partial state leaked: %v", effects)
	}
	if keys, _ := f.receiverStore.Keys(); len(keys) != 0 {
		t.Fatalf("receiver store not clean after failed batch: %v", keys)
	}

	f.drain(t, 10, nil)
	f.verifyAgainstLedger(t)
}

// TestReceiverCrashAfterCommitRetriesSafely: the batch commits but the caller
// sees an error, so the sender retries; dedup keeps the effect at exactly one.
func TestReceiverCrashAfterCommitRetriesSafely(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 3)

	f.receiverStore.FailNextBatchAfterCommit(3)
	f.drain(t, 20, nil)
	f.verifyAgainstLedger(t)
}

// TestSenderOutboxFailures: enqueue fails cleanly when the outbox write
// fails, and a failed outbox-delete after ack causes a safe retransmission.
func TestSenderOutboxFailures(t *testing.T) {
	f := newFixture()

	// Enqueue against a failing store: nothing is queued.
	f.senderStore.FailNextBatchBeforeCommit(1)
	msg := Message{ID: "m1", Payload: []byte("hello")}
	if err := f.sender.Enqueue(msg); !errors.Is(err, ErrInjected) {
		t.Fatalf("enqueue err = %v, want ErrInjected", err)
	}
	if pending, _ := f.sender.Pending(); pending != 0 {
		t.Fatalf("pending = %d after failed enqueue, want 0", pending)
	}

	// Retry succeeds once the store recovers.
	if err := f.sender.Enqueue(msg); err != nil {
		t.Fatalf("enqueue retry: %v", err)
	}
	if err := f.ledger.Record(msg); err != nil {
		t.Fatalf("ledger: %v", err)
	}

	// First ack arrives but retiring the outbox record fails -> the message
	// is retransmitted and deduped by the receiver.
	f.senderStore.FailNextBatchBeforeCommit(1)
	f.drain(t, 10, nil)
	f.verifyAgainstLedger(t)
}

// TestPayloadConflictRejected: the same ID carrying a different payload is
// rejected, on the receiver and on re-enqueue at the sender.
func TestPayloadConflictRejected(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 1)
	f.drain(t, 10, nil)

	// Direct delivery of a conflicting payload under the same ID.
	ack, err := f.receiver.Receive(Message{ID: "msg-000", Payload: []byte("tampered")})
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if ack.Status != AckConflict {
		t.Fatalf("ack = %v, want AckConflict", ack.Status)
	}

	// Sender-side: re-enqueue with a changed payload while still pending.
	g := newFixture()
	m := Message{ID: "x", Payload: []byte("a")}
	if err := g.sender.Enqueue(m); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := g.sender.Enqueue(Message{ID: "x", Payload: []byte("b")}); err == nil {
		t.Fatal("expected outbox conflict for changed payload")
	}
	if err := g.sender.Enqueue(m); err != nil {
		t.Fatalf("idempotent re-enqueue: %v", err)
	}

	// The tampered delivery changed nothing.
	f.verifyAgainstLedger(t)
}

// TestPartitionThenHeal: nothing flows during a partition; everything
// arrives exactly once after healing.
func TestPartitionThenHeal(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 8)

	f.tx.SetPartition(true)
	for i := 0; i < 3; i++ {
		if _, err := f.sender.PumpOnce(); err != nil {
			t.Fatalf("pump during partition: %v", err)
		}
	}
	if pending, _ := f.sender.Pending(); pending != 8 {
		t.Fatalf("pending = %d during partition, want 8", pending)
	}
	if effects, _ := f.receiver.Effects(); len(effects) != 0 {
		t.Fatalf("effects leaked during partition: %v", effects)
	}

	f.tx.SetPartition(false)
	f.drain(t, 20, nil)
	f.verifyAgainstLedger(t)
}

// TestConcurrentPumps hammers pump rounds from several goroutines while
// faults fire, to shake out races in dedup and outbox handling (run with
// -race).
func TestConcurrentPumps(t *testing.T) {
	f := newFixture()
	f.enqueue(t, 50)

	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for round := 0; round < 100; round++ {
				if round%7 == w {
					f.tx.LoseNextAcks(1)
					f.receiverStore.FailNextBatchAfterCommit(1)
				}
				if _, err := f.sender.PumpOnce(); err != nil {
					t.Errorf("pump: %v", err)
					return
				}
				if pending, err := f.sender.Pending(); err == nil && pending == 0 {
					return
				}
			}
		}(w)
	}
	wg.Wait()

	if pending, _ := f.sender.Pending(); pending != 0 {
		t.Fatalf("pending = %d, want 0", pending)
	}
	f.verifyAgainstLedger(t)
}
