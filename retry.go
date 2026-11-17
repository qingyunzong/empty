package formal

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// RetryPolicy bounds how long a reader waits for an eventually visible object.
// Poll is called between failed attempts; when nil it sleeps for Backoff.
type RetryPolicy struct {
	Attempts int
	Backoff  time.Duration
	Poll     func(ctx context.Context, attempt int) error
}

func (p RetryPolicy) normalized() RetryPolicy {
	if p.Attempts <= 0 {
		p.Attempts = 32
	}
	if p.Poll == nil {
		backoff := p.Backoff
		if backoff <= 0 {
			backoff = 2 * time.Millisecond
		}
		p.Poll = func(ctx context.Context, _ int) error {
			timer := time.NewTimer(backoff)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		}
	}
	return p
}

// getWithRetry reads key, treating ErrNotFound as a transient visibility delay.
// Other errors are returned immediately.
func getWithRetry(ctx context.Context, store Store, key string, policy RetryPolicy) (Object, error) {
	policy = policy.normalized()
	for attempt := 0; attempt < policy.Attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return Object{}, err
		}
		obj, err := store.Get(ctx, key)
		if err == nil {
			return obj, nil
		}
		if !errors.Is(err, ErrNotFound) {
			return Object{}, err
		}
		if attempt+1 == policy.Attempts {
			break
		}
		if err := policy.Poll(ctx, attempt+1); err != nil {
			return Object{}, err
		}
	}
	return Object{}, fmt.Errorf("%w: %s not visible after %d attempts", ErrNotFound, key, policy.Attempts)
}
