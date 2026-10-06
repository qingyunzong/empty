package comm

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"testing"
)

// TestExactlyOnceUnderFaults injects persisted-write faults on both sides
// plus request/ack loss, then reconciles the receiver's effect journal
// against the complete message ledger: every ID must have its effect
// applied exactly once.
func TestExactlyOnceUnderFaults(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	senderStore := NewMemStore()
	receiverStore := NewMemStore()
	receiver := NewReceiver(receiverStore)
	transport := &FlakyTransport{
		Receiver:    receiver,
		DropRequest: func() bool { return rng.Float64() < 0.2 },
		DropAck:     func() bool { return rng.Float64() < 0.2 },
	}
	sender := NewSender(senderStore, transport)

	// The ledger records every message accepted into the outbox.
	ledger := map[string]string{}
	const n = 50
	for i := 0; i < n; i++ {
		msg := Message{ID: fmt.Sprintf("m%03d", i), Payload: fmt.Sprintf("payload-%d", i)}
		for {
			if rng.Float64() < 0.2 {
				senderStore.FailNextApplies++ // sender-side persist fault
			}
			if err := sender.Enqueue(msg); err == nil {
				ledger[msg.ID] = msg.Payload
				break
			}
		}
	}

	// Relay with both stores faulting and the network flapping.
	for round := 0; round < 2000 && sender.Pending() > 0; round++ {
		if rng.Float64() < 0.3 {
			senderStore.FailNextApplies++
		}
		if rng.Float64() < 0.3 {
			receiverStore.FailNextApplies++
		}
		if err := sender.RelayOnce(context.Background()); err != nil {
			t.Fatalf("relay: %v", err)
		}
	}
	if got := sender.Pending(); got != 0 {
		t.Fatalf("outbox not drained, %d pending", got)
	}

	// Reconcile effects against the ledger.
	log := receiver.EffectLog()
	if len(log) != len(ledger) {
		t.Fatalf("effect count = %d, want %d (ledger size)", len(log), len(ledger))
	}
	seen := map[string]bool{}
	for _, id := range log {
		if seen[id] {
			t.Fatalf("effect applied twice for %s", id)
		}
		seen[id] = true
		want, ok := ledger[id]
		if !ok {
			t.Fatalf("effect for %s not in ledger", id)
		}
		got, _ := receiver.Effect(id)
		if got != want {
			t.Fatalf("effect[%s] = %q, want %q", id, got, want)
		}
	}
	for id := range ledger {
		if !seen[id] {
			t.Fatalf("ledger message %s never applied", id)
		}
	}
}

// TestAckLossRedeliversButAppliesOnce drops the first ack so the sender
// retries; the receiver must dedup and keep a single effect.
func TestAckLossRedeliversButAppliesOnce(t *testing.T) {
	receiver := NewReceiver(NewMemStore())
	ackDropped := false
	transport := &FlakyTransport{
		Receiver: receiver,
		DropAck: func() bool {
			if !ackDropped {
				ackDropped = true
				return true
			}
			return false
		},
	}
	sender := NewSender(NewMemStore(), transport)
	if err := sender.Enqueue(Message{ID: "m1", Payload: "hello"}); err != nil {
		t.Fatal(err)
	}
	if err := sender.RelayUntil(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	if log := receiver.EffectLog(); len(log) != 1 || log[0] != "m1" {
		t.Fatalf("effect log = %v, want exactly [m1]", log)
	}
	if got, _ := receiver.Effect("m1"); got != "hello" {
		t.Fatalf("effect = %q, want hello", got)
	}
}

// TestConflictingPayloadRejected: a second delivery reusing an ID with a
// different payload is rejected and the original effect is preserved.
func TestConflictingPayloadRejected(t *testing.T) {
	receiverStore := NewMemStore()
	receiver := NewReceiver(receiverStore)
	sender1 := NewSender(NewMemStore(), DirectTransport{Receiver: receiver})
	if err := sender1.Enqueue(Message{ID: "m1", Payload: "original"}); err != nil {
		t.Fatal(err)
	}
	if err := sender1.RelayUntil(context.Background(), 10); err != nil {
		t.Fatal(err)
	}

	// A different sender reuses the ID with a changed payload.
	sender2 := NewSender(NewMemStore(), DirectTransport{Receiver: receiver})
	if err := sender2.Enqueue(Message{ID: "m1", Payload: "tampered"}); err != nil {
		t.Fatal(err)
	}
	if err := sender2.RelayUntil(context.Background(), 10); err != nil {
		t.Fatal(err)
	}

	ack, err := receiver.Receive(Message{ID: "m1", Payload: "tampered"})
	if err != nil {
		t.Fatal(err)
	}
	if ack.Status != AckRejected {
		t.Fatalf("status = %s, want rejected", ack.Status)
	}
	if got, _ := receiver.Effect("m1"); got != "original" {
		t.Fatalf("effect = %q, want original", got)
	}
	if log := receiver.EffectLog(); len(log) != 1 {
		t.Fatalf("effect log = %v, want a single entry", log)
	}
	if sender2.Pending() != 0 {
		t.Fatal("rejected message must be dropped from the outbox")
	}
}

// TestAtomicBatchRollbackOnFault: when the receiver's persisted write
// fails, neither the dedup record nor the effect survives, so the
// sender's retry applies cleanly.
func TestAtomicBatchRollbackOnFault(t *testing.T) {
	receiverStore := NewMemStore()
	receiver := NewReceiver(receiverStore)
	receiverStore.FailNextApplies = 1

	msg := Message{ID: "m1", Payload: "p"}
	if _, err := receiver.Receive(msg); !errors.Is(err, ErrInjectedFault) {
		t.Fatalf("err = %v, want ErrInjectedFault", err)
	}
	if log := receiver.EffectLog(); len(log) != 0 {
		t.Fatalf("partial batch survived: %v", log)
	}
	if _, ok := receiver.Effect("m1"); ok {
		t.Fatal("effect persisted despite failed batch")
	}

	ack, err := receiver.Receive(msg)
	if err != nil || ack.Status != AckApplied {
		t.Fatalf("retry: ack=%+v err=%v", ack, err)
	}
	if log := receiver.EffectLog(); len(log) != 1 {
		t.Fatalf("effect log = %v, want one entry", log)
	}
}

// TestEnqueueTxIsAtomic: business writes and the outbox entry land in the
// same batch; an injected fault rolls back both.
func TestEnqueueTxIsAtomic(t *testing.T) {
	store := NewMemStore()
	sender := NewSender(store, DirectTransport{Receiver: NewReceiver(NewMemStore())})
	store.FailNextApplies = 1

	err := sender.EnqueueTx(Message{ID: "m1", Payload: "p"}, map[string]string{"balance/alice": "100"})
	if !errors.Is(err, ErrInjectedFault) {
		t.Fatalf("err = %v, want ErrInjectedFault", err)
	}
	if sender.Pending() != 0 {
		t.Fatal("outbox entry survived failed transaction")
	}
	if _, ok := store.Get("balance/alice"); ok {
		t.Fatal("business write survived failed transaction")
	}

	if err := sender.EnqueueTx(Message{ID: "m1", Payload: "p"}, map[string]string{"balance/alice": "100"}); err != nil {
		t.Fatal(err)
	}
	if sender.Pending() != 1 {
		t.Fatal("outbox entry missing after retry")
	}
	if v, _ := store.Get("balance/alice"); v != "100" {
		t.Fatalf("balance = %q, want 100", v)
	}
}

// TestSenderRestartResumesOutbox: a new Sender over the same persisted
// store picks up pending outbox entries after a "restart".
func TestSenderRestartResumesOutbox(t *testing.T) {
	store := NewMemStore()
	receiver := NewReceiver(NewMemStore())
	sender := NewSender(store, DirectTransport{Receiver: receiver})
	for _, id := range []string{"a", "b", "c"} {
		if err := sender.Enqueue(Message{ID: id, Payload: "p-" + id}); err != nil {
			t.Fatal(err)
		}
	}

	restarted := NewSender(store, DirectTransport{Receiver: receiver})
	if restarted.Pending() != 3 {
		t.Fatalf("pending = %d, want 3", restarted.Pending())
	}
	if err := restarted.RelayUntil(context.Background(), 10); err != nil {
		t.Fatal(err)
	}
	if log := receiver.EffectLog(); len(log) != 3 {
		t.Fatalf("effect log = %v, want 3 entries", log)
	}
}
