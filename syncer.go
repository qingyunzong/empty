package fieldsync

import (
	"context"
	"fmt"
	"time"
)

// Config controls Syncer behavior.
type Config struct {
	// Rules is the exhaustive list of equivalence rules applied during
	// comparison. Nothing else is normalized.
	Rules []EquivalenceRule
	// ReadBackAttempts bounds how many times the post-write read is retried
	// while the store returns stale data. Defaults to 3.
	ReadBackAttempts int
	// ReadBackDelay is the wait between read-back attempts.
	ReadBackDelay time.Duration
}

// Result summarizes a successful Sync.
type Result struct {
	// Receipt is the write receipt, or the current store receipt when no
	// write was needed.
	Receipt Receipt
	// Wrote is false when the pre-write read already matched the desired
	// batch, making the sync a no-op (the retry-safe path).
	Wrote bool
}

// Syncer synchronizes batches into a Store with read-back verification.
type Syncer struct {
	store Store
	cfg   Config
}

// NewSyncer builds a Syncer with defaults applied to cfg.
func NewSyncer(store Store, cfg Config) *Syncer {
	if cfg.ReadBackAttempts <= 0 {
		cfg.ReadBackAttempts = 3
	}
	return &Syncer{store: store, cfg: cfg}
}

// Sync makes key hold exactly want. It first reads the current state and
// skips the write entirely when it already matches, so retries after an
// ambiguous failure are safe. After writing, it reads back and compares with
// only the declared equivalence rules applied; persistent mismatch yields a
// *VerificationError carrying the write receipt and concrete diffs.
func (s *Syncer) Sync(ctx context.Context, key string, want Batch) (Result, error) {
	current, receipt, err := s.store.Read(ctx, key)
	if err != nil {
		return Result{}, fmt.Errorf("fieldsync: pre-write read: %w", err)
	}
	if diffs := diffBatch(want, current, s.cfg.Rules); len(diffs) == 0 {
		return Result{Receipt: receipt, Wrote: false}, nil
	}

	writeReceipt, err := s.store.Write(ctx, key, want)
	if err != nil {
		return Result{}, fmt.Errorf("fieldsync: write: %w", err)
	}

	var diffs []Diff
	for attempt := 0; attempt < s.cfg.ReadBackAttempts; attempt++ {
		if attempt > 0 && s.cfg.ReadBackDelay > 0 {
			select {
			case <-ctx.Done():
				return Result{}, ctx.Err()
			case <-time.After(s.cfg.ReadBackDelay):
			}
		}
		got, _, err := s.store.Read(ctx, key)
		if err != nil {
			return Result{}, fmt.Errorf("fieldsync: read-back: %w", err)
		}
		if diffs = diffBatch(want, got, s.cfg.Rules); len(diffs) == 0 {
			return Result{Receipt: writeReceipt, Wrote: true}, nil
		}
	}
	return Result{}, &VerificationError{Key: key, Receipt: writeReceipt, Diffs: diffs}
}
