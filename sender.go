package comm

import (
	"context"
	"fmt"
	"strings"
)

const outboxPrefix = "outbox/"

// Sender implements the transactional outbox pattern: messages are first
// persisted to an outbox (atomically with any business writes), then a
// relay delivers them and clears them only after the receiver's ack.
type Sender struct {
	store     Store
	transport Transport
}

func NewSender(store Store, transport Transport) *Sender {
	return &Sender{store: store, transport: transport}
}

func (s *Sender) SetTransport(t Transport) { s.transport = t }

// Enqueue persists msg in the outbox. Safe to retry on error: the write
// is atomic, so a failed Enqueue leaves no partial state.
func (s *Sender) Enqueue(msg Message) error {
	return s.EnqueueTx(msg, nil)
}

// EnqueueTx persists msg in the outbox in the same atomic batch as the
// caller's business writes, so a message is never lost nor emitted
// without its accompanying state change.
func (s *Sender) EnqueueTx(msg Message, businessPuts map[string]string) error {
	b := Batch{Puts: map[string]string{outboxPrefix + msg.ID: msg.Payload}}
	for k, v := range businessPuts {
		b.Puts[k] = v
	}
	return s.store.Apply(b)
}

// Pending reports how many outbox entries still await an ack.
func (s *Sender) Pending() int {
	return len(s.store.Keys(outboxPrefix))
}

// RelayOnce attempts one delivery of every pending outbox entry.
// Entries whose delivery or cleanup fails stay in the outbox and are
// retried on the next round.
func (s *Sender) RelayOnce(ctx context.Context) error {
	for _, key := range s.store.Keys(outboxPrefix) {
		if err := ctx.Err(); err != nil {
			return err
		}
		payload, ok := s.store.Get(key)
		if !ok {
			continue
		}
		id := strings.TrimPrefix(key, outboxPrefix)
		ack, err := s.transport.Send(ctx, Message{ID: id, Payload: payload})
		if err != nil {
			// Network fault or transient receiver failure: keep the
			// entry and retry later.
			continue
		}
		switch ack.Status {
		case AckApplied, AckDuplicate, AckRejected:
			// Applied/duplicate: delivered, stop retrying.
			// Rejected: poison message (payload changed for an existing
			// ID); retrying can never succeed, so drop it.
			if err := s.store.Apply(Batch{Dels: []string{key}}); err != nil {
				// Store fault: entry stays, will be retried.
				continue
			}
		}
	}
	return nil
}

// RelayUntil relays until the outbox is empty or maxRounds is exhausted.
func (s *Sender) RelayUntil(ctx context.Context, maxRounds int) error {
	for round := 0; round < maxRounds && s.Pending() > 0; round++ {
		if err := s.RelayOnce(ctx); err != nil {
			return err
		}
	}
	if s.Pending() > 0 {
		return fmt.Errorf("relay: %d message(s) still pending after %d rounds", s.Pending(), maxRounds)
	}
	return nil
}
