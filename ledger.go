package commlib

import (
	"bytes"
	"fmt"
	"sync"
)

// Ledger is the authoritative record of every message the application
// intended to send. The receiver's final effects are verified against it:
// exactly one effect per ledger ID, with a matching payload.
type Ledger struct {
	mu   sync.Mutex
	msgs map[string][]byte
}

func NewLedger() *Ledger {
	return &Ledger{msgs: make(map[string][]byte)}
}

// Record adds a message to the ledger. Re-recording the same ID with the
// same payload is a no-op; a changed payload is a conflict.
func (l *Ledger) Record(msg Message) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if prev, ok := l.msgs[msg.ID]; ok {
		if !bytes.Equal(prev, msg.Payload) {
			return fmt.Errorf("commlib: ledger conflict for ID %q: payload changed", msg.ID)
		}
		return nil
	}
	l.msgs[msg.ID] = append([]byte(nil), msg.Payload...)
	return nil
}

// Messages returns a copy of the ledger keyed by message ID.
func (l *Ledger) Messages() map[string][]byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string][]byte, len(l.msgs))
	for id, payload := range l.msgs {
		out[id] = append([]byte(nil), payload...)
	}
	return out
}

// VerifyExactlyOnce checks that effects hold exactly one entry per ledger ID
// with a matching payload — no missing, no extra, no altered effects.
func VerifyExactlyOnce(ledger, effects map[string][]byte) error {
	for id, want := range ledger {
		got, ok := effects[id]
		if !ok {
			return fmt.Errorf("commlib: missing effect for ID %q", id)
		}
		if !bytes.Equal(got, want) {
			return fmt.Errorf("commlib: effect payload mismatch for ID %q", id)
		}
	}
	for id := range effects {
		if _, ok := ledger[id]; !ok {
			return fmt.Errorf("commlib: unexpected effect for unknown ID %q", id)
		}
	}
	return nil
}
