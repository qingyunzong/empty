package q204

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
)

// Batch is an immutable submission bound to one resolved key version.
//
// Retries operate on a fresh copy of the submitted events and reuse the same
// key bytes, so rotation of the store's active key cannot change output for an
// existing batch. A revoked batch rejects all further processing.
type Batch struct {
	ID string

	rules    *RuleSet
	events   []Event
	store    KeyStore
	revokeBy BatchKeyRevoker

	opMu     sync.Mutex
	revokeMu sync.Mutex
	revoked  atomic.Bool

	keyRef    KeyRef
	key       []byte
	revokeErr error
}

// Event is a structured event. Values should be JSON-like: maps with string
// keys, slices/arrays, strings, numbers, booleans, and nil. Other map and slice
// types are normalized to map[string]any and []any.
type Event = any

// BatchRequest describes one submission. Rules are validated for that batch.
// If ID is empty, StartBatch generates one.
type BatchRequest struct {
	ID     string  `json:"id,omitempty"`
	Rules  []Rule  `json:"rules"`
	Events []Event `json:"events"`
}

func newBatch(rules *RuleSet, events []Event, store KeyStore, batchID string) *Batch {
	batch := &Batch{
		ID:     batchID,
		rules:  rules,
		events: events,
		store:  store,
	}
	if revoker, ok := store.(BatchKeyRevoker); ok {
		batch.revokeBy = revoker
	}
	return batch
}

// Process applies the batch rules and returns de-identified events. It never
// returns a partially transformed result: any error rejects the whole batch.
// The submitted events are not mutated, and a replacement value is never fed
// back through the rules.
func (b *Batch) Process(ctx context.Context) ([]Event, error) {
	if b == nil {
		return nil, fmt.Errorf("%w: nil batch", ErrBatchRevoked)
	}
	if b.revoked.Load() {
		return nil, batchRevokedError(b.ID)
	}

	b.opMu.Lock()
	defer b.opMu.Unlock()
	if b.revoked.Load() {
		return nil, batchRevokedError(b.ID)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	result := make([]Event, 0, len(b.events))
	for i, event := range b.events {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if b.revoked.Load() {
			return nil, batchRevokedError(b.ID)
		}
		deidentified, err := b.rules.deidentify(cloneValue(event), b.key)
		if err != nil {
			return nil, fmt.Errorf("event %d: %w", i, err)
		}
		result = append(result, deidentified)
	}
	if b.revoked.Load() {
		return nil, batchRevokedError(b.ID)
	}
	return result, nil
}

// Retry re-processes the original submission with the batch's original key
// snapshot. It produces the same bytes as an earlier successful Process call,
// regardless of key rotation that happened in between.
func (b *Batch) Retry(ctx context.Context) ([]Event, error) {
	return b.Process(ctx)
}

// Revoke permanently invalidates the batch. The local key bytes and reference
// are cleared before the keystore's optional revocation hook is called. The
// batch remains revoked even if that hook fails.
func (b *Batch) Revoke(ctx context.Context) error {
	if b == nil {
		return nil
	}

	b.revokeMu.Lock()
	defer b.revokeMu.Unlock()
	if b.revoked.Load() {
		return b.revokeErr
	}

	// Set this before waiting for an in-flight Process call. Process checks it
	// between events and before returning.
	b.revoked.Store(true)

	b.opMu.Lock()
	ref := b.keyRef
	b.keyRef = KeyRef{}
	wipe(b.key)
	b.key = nil
	b.events = nil
	b.opMu.Unlock()

	if !ref.IsZero() {
		if b.revokeBy != nil {
			if err := b.revokeBy.RevokeBatch(ctx, b.ID, ref); err != nil {
				b.revokeErr = fmt.Errorf("revoke batch %s: %w", b.ID, err)
			}
		} else if revoker, ok := b.store.(KeyRevoker); ok {
			if err := revoker.RevokeKey(ctx, ref); err != nil {
				b.revokeErr = fmt.Errorf("revoke key for batch %s: %w", b.ID, err)
			}
		}
	}
	return b.revokeErr
}

// Revoked reports whether the batch has been revoked.
func (b *Batch) Revoked() bool {
	return b != nil && b.revoked.Load()
}

func batchRevokedError(batchID string) error {
	if batchID == "" {
		return ErrBatchRevoked
	}
	return fmt.Errorf("%w: %s", ErrBatchRevoked, batchID)
}

func wipe(bytes []byte) {
	for i := range bytes {
		bytes[i] = 0
	}
}
