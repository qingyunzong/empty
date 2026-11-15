package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Backoff computes exponentially growing delays between attempts.
type Backoff struct {
	Initial time.Duration
	Max     time.Duration
	Factor  float64
}

// Delay returns the wait before the given (zero-based) retry attempt.
func (b Backoff) Delay(attempt int) time.Duration {
	d := b.Initial
	for i := 0; i < attempt; i++ {
		d = time.Duration(float64(d) * b.Factor)
		if d >= b.Max {
			return b.Max
		}
	}
	return d
}

// Config tunes a Runner.
type Config struct {
	// PollBackoff spaces Status polls while the job is not ready.
	PollBackoff Backoff
	// CreateBackoff spaces create retries after a timeout without a
	// recoverable job id.
	CreateBackoff Backoff
	// MaxCreateAttempts bounds create retries after unrecovered timeouts.
	MaxCreateAttempts int
	// ShardConcurrency bounds parallel shard downloads.
	ShardConcurrency int

	// now and sleep are injectable for tests.
	now   func() time.Time
	sleep func(ctx context.Context, d time.Duration) error
}

func (c *Config) withDefaults() {
	if c.PollBackoff.Initial == 0 {
		c.PollBackoff = Backoff{Initial: 500 * time.Millisecond, Max: 30 * time.Second, Factor: 2}
	}
	if c.CreateBackoff.Initial == 0 {
		c.CreateBackoff = Backoff{Initial: 200 * time.Millisecond, Max: 5 * time.Second, Factor: 2}
	}
	if c.MaxCreateAttempts == 0 {
		c.MaxCreateAttempts = 5
	}
	if c.ShardConcurrency <= 0 {
		c.ShardConcurrency = 4
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.sleep == nil {
		c.sleep = func(ctx context.Context, d time.Duration) error {
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
}

// Runner drives export tasks through their lifecycle: create (idempotent),
// poll with backoff, download + verify shards, then commit. Cancellation
// races with completion through the Store's atomic terminal transitions.
type Runner struct {
	client ExportClient
	store  Store
	cfg    Config
}

func NewRunner(client ExportClient, store Store, cfg Config) *Runner {
	cfg.withDefaults()
	return &Runner{client: client, store: store, cfg: cfg}
}

// Run executes the task to a terminal state. It is safe to call again with
// the same Task after a crash: the persisted idempotency-key mapping resumes
// the existing remote job instead of creating a duplicate.
func (r *Runner) Run(ctx context.Context, task Task) error {
	if err := r.store.RegisterTask(ctx, task.ID); err != nil {
		return err
	}

	jobID, err := r.ensureJob(ctx, task)
	if err != nil {
		return err
	}

	status, err := r.pollUntilReady(ctx, task.ID, jobID)
	if err != nil {
		r.fail(task.ID)
		return err
	}

	if err := r.downloadShards(ctx, task.ID, jobID, status.Shards); err != nil {
		r.fail(task.ID)
		return err
	}

	// Commit only wins if every shard is persisted and no cancellation
	// landed first; the Store guarantees exactly one terminal transition.
	won, err := r.store.TryCommit(ctx, task.ID, len(status.Shards))
	if err != nil {
		return err
	}
	if !won {
		return ErrCancelled
	}
	return nil
}

// Cancel requests cancellation of a running task. It returns true when this
// call won the race to the terminal state; completion and cancellation can
// never both win.
func (r *Runner) Cancel(ctx context.Context, taskID string) (bool, error) {
	won, err := r.store.TryCancel(ctx, taskID)
	if err != nil || !won {
		return won, err
	}
	if jobID, ok, lerr := r.store.JobFor(ctx, taskID); lerr == nil && ok {
		_ = r.client.Cancel(ctx, jobID) // best effort
	}
	return true, nil
}

// ensureJob resolves the remote job id without ever starting a duplicate
// export: a persisted mapping wins, and a create timeout is resolved by
// querying the idempotency key before any retry.
func (r *Runner) ensureJob(ctx context.Context, task Task) (string, error) {
	if jobID, ok, err := r.store.LoadJob(ctx, task.IdempotencyKey); err != nil {
		return "", err
	} else if ok {
		return jobID, nil
	}

	var lastErr error
	for attempt := 0; attempt < r.cfg.MaxCreateAttempts; attempt++ {
		if attempt > 0 {
			if err := r.cfg.sleep(ctx, r.cfg.CreateBackoff.Delay(attempt-1)); err != nil {
				return "", err
			}
		}
		jobID, err := r.client.CreateExport(ctx, task.Request)
		switch {
		case err == nil:
			return jobID, r.store.SaveJob(ctx, task.ID, task.IdempotencyKey, jobID)
		case errors.Is(err, ErrCreateTimeout):
			// The job may exist remotely; never blind-retry the create.
			foundID, found, qerr := r.client.FindByIdempotencyKey(ctx, task.IdempotencyKey)
			if qerr != nil {
				lastErr = qerr
				continue
			}
			if found {
				return foundID, r.store.SaveJob(ctx, task.ID, task.IdempotencyKey, foundID)
			}
			// Definitely not created: retrying with the same idempotency
			// key is safe.
			lastErr = err
		default:
			return "", err
		}
	}
	return "", fmt.Errorf("dataeng: create export: %w", lastErr)
}

func (r *Runner) pollUntilReady(ctx context.Context, taskID, jobID string) (JobStatus, error) {
	for attempt := 0; ; attempt++ {
		if err := r.checkActive(ctx, taskID); err != nil {
			return JobStatus{}, err
		}
		status, err := r.client.Status(ctx, jobID)
		if err != nil {
			return JobStatus{}, err
		}
		switch status.State {
		case RemoteReady:
			return status, nil
		case RemoteFailed:
			return JobStatus{}, fmt.Errorf("%w: job %s", ErrJobFailed, jobID)
		}
		if !status.ExpiresAt.IsZero() && !r.cfg.now().Before(status.ExpiresAt) {
			return JobStatus{}, fmt.Errorf("%w: job %s expired at %s",
				ErrJobExpired, jobID, status.ExpiresAt.Format(time.RFC3339))
		}
		if err := r.cfg.sleep(ctx, r.cfg.PollBackoff.Delay(attempt)); err != nil {
			return JobStatus{}, err
		}
	}
}

// downloadShards downloads shards concurrently, verifies each digest, and
// persists shards one by one. Nothing is committed here; Run commits only
// after every shard is safely stored.
func (r *Runner) downloadShards(ctx context.Context, taskID, jobID string, shards []Shard) error {
	sem := make(chan struct{}, r.cfg.ShardConcurrency)
	var wg sync.WaitGroup
	errCh := make(chan error, len(shards))

	for _, sh := range shards {
		if err := r.checkActive(ctx, taskID); err != nil {
			return err
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(sh Shard) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := r.fetchShard(ctx, taskID, jobID, sh); err != nil {
				errCh <- err
			}
		}(sh)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		return err
	}
	return nil
}

func (r *Runner) fetchShard(ctx context.Context, taskID, jobID string, sh Shard) error {
	rc, err := r.client.DownloadShard(ctx, jobID, sh.Index)
	if err != nil {
		return err
	}
	defer rc.Close()

	data, err := io.ReadAll(rc)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if got := hex.EncodeToString(sum[:]); got != sh.Digest {
		return fmt.Errorf("%w: shard %d: got %s, want %s", ErrDigestMismatch, sh.Index, got, sh.Digest)
	}
	return r.store.SaveShard(ctx, taskID, PersistedShard{
		Index:  sh.Index,
		Digest: sh.Digest,
		Data:   data,
	})
}

// checkActive aborts the run as soon as the task left the active state,
// e.g. because Cancel won the race.
func (r *Runner) checkActive(ctx context.Context, taskID string) error {
	state, err := r.store.State(ctx, taskID)
	if err != nil {
		return err
	}
	if state == TaskCancelled {
		return ErrCancelled
	}
	if state.Terminal() {
		return fmt.Errorf("dataeng: task %s already %s", taskID, state)
	}
	return nil
}

func (r *Runner) fail(taskID string) {
	// Best effort: cancellation may already have won the terminal state.
	_, _ = r.store.TryFail(context.Background(), taskID)
}
