package synclib

import (
	"context"
	"errors"
	"time"
)

// RetryPolicy controls SyncWithRetry.
type RetryPolicy struct {
	// MaxAttempts is the total number of write attempts; values < 1 mean 1.
	MaxAttempts int
	// Backoff is the wait between attempts.
	Backoff time.Duration
	// Sleep overrides how backoff is waited out (e.g. a fake clock in
	// tests). Nil uses a context-aware timer.
	Sleep func(ctx context.Context, d time.Duration) error
}

// SyncWithRetry retries Sync until the record verifies or attempts run out.
// Before every attempt it reads the store first: if the desired state is
// already visible (e.g. a previous attempt actually landed), it returns the
// existing receipt without writing again. The final error retains the last
// write's receipt and diffs when it is a *MismatchError.
func (s *Syncer) SyncWithRetry(ctx context.Context, rec Record, p RetryPolicy) (Receipt, error) {
	if p.MaxAttempts < 1 {
		p.MaxAttempts = 1
	}
	sleep := p.Sleep
	if sleep == nil {
		sleep = func(ctx context.Context, d time.Duration) error {
			if d <= 0 {
				return nil
			}
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		}
	}
	var lastReceipt Receipt
	var lastErr error
	for attempt := 1; attempt <= p.MaxAttempts; attempt++ {
		if existing, receipt, err := s.Store.Read(ctx, rec.ID); err == nil {
			if s.Matches(rec, existing) {
				return receipt, nil
			}
		} else if !errors.Is(err, ErrNotFound) {
			lastErr = err
		}
		receipt, err := s.Sync(ctx, rec)
		lastReceipt = receipt
		if err == nil {
			return receipt, nil
		}
		lastErr = err
		if attempt < p.MaxAttempts {
			if serr := sleep(ctx, p.Backoff); serr != nil {
				return lastReceipt, serr
			}
		}
	}
	return lastReceipt, lastErr
}
