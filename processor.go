package q204

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// Processor starts batches against a keystore. It is safe for concurrent use.
type Processor struct {
	store KeyStore
}

// New creates a processor. A nil store is allowed for rule sets that do not
// contain HMAC actions.
func New(store KeyStore) *Processor {
	return &Processor{store: store}
}

// StartBatch validates the rule set, takes a deep copy of the events, and, when
// any rule uses HMAC, resolves and snapshots one key version for the batch.
// Key rotation after this call affects only newly started batches.
func (p *Processor) StartBatch(ctx context.Context, request BatchRequest) (*Batch, error) {
	if p == nil {
		return nil, fmt.Errorf("%w: nil processor", ErrInvalidConfig)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	rules, err := CompileRules(request.Rules)
	if err != nil {
		return nil, err
	}

	events := make([]Event, len(request.Events))
	for i, event := range request.Events {
		normalized, normalizeErr := normalizeValue(event)
		if normalizeErr != nil {
			return nil, fmt.Errorf("event %d: %w", i, normalizeErr)
		}
		events[i] = normalized
	}

	batchID := request.ID
	if batchID == "" {
		batchID, err = generateBatchID()
		if err != nil {
			return nil, err
		}
	}

	batch := newBatch(rules, events, p.store, batchID)
	if rules.usesHMAC() {
		if p.store == nil {
			return nil, ErrKeyStoreRequired
		}
		ref, acquireErr := p.store.Current(ctx)
		if acquireErr != nil {
			return nil, fmt.Errorf("resolve current key for batch %s: %w", batchID, acquireErr)
		}
		key, loadErr := p.store.Load(ctx, ref)
		if loadErr != nil {
			return nil, fmt.Errorf("load key for batch %s: %w", batchID, loadErr)
		}
		batch.keyRef = ref
		batch.key = append([]byte(nil), key...)
	}
	return batch, nil
}

// Submit is an alias for StartBatch.
func (p *Processor) Submit(ctx context.Context, request BatchRequest) (*Batch, error) {
	return p.StartBatch(ctx, request)
}

// ProcessBatch starts and processes a batch in one call.
func (p *Processor) ProcessBatch(ctx context.Context, request BatchRequest) ([]Event, error) {
	batch, err := p.StartBatch(ctx, request)
	if err != nil {
		return nil, err
	}
	return batch.Process(ctx)
}

func generateBatchID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("q204: generate batch id: %w", err)
	}
	return "batch-" + hex.EncodeToString(raw[:]), nil
}
