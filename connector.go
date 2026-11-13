package dataeng

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

var (
	// ErrResumeTokenInvalid is returned by a Stream or StreamOpener when the
	// server rejects the supplied resume token. A new snapshot must be started;
	// the stream must not be resumed by moving the token forward.
	ErrResumeTokenInvalid = errors.New("dataeng: resume token invalid")

	// ErrNoSnapshotStarter means a snapshot must be created but Config.Snapshots
	// is nil.
	ErrNoSnapshotStarter = errors.New("dataeng: snapshot starter is not configured")

	// ErrAlreadyRunning is returned when Run is called concurrently.
	ErrAlreadyRunning = errors.New("dataeng: connector is already running")

	// ErrInvalidSnapshot means SnapshotStarter returned an empty or unchanged
	// snapshot ID.
	ErrInvalidSnapshot = errors.New("dataeng: invalid replacement snapshot")

	// ErrReconciliationPending means a replacement snapshot completed but its
	// reconciliation was not durably finished. The connector refuses to mark
	// the snapshot complete, so old and new results cannot be silently joined.
	ErrReconciliationPending = errors.New("dataeng: snapshot reconciliation pending")

	errProtocol = errors.New("dataeng: invalid server batch")
)

type sinkFailure struct {
	err error
}

func (e *sinkFailure) Error() string { return "dataeng: sink failure: " + e.err.Error() }
func (e *sinkFailure) Unwrap() error { return e.err }

type lifecycleFailure struct {
	err error
}

func (e *lifecycleFailure) Error() string {
	return "dataeng: snapshot lifecycle failure: " + e.err.Error()
}
func (e *lifecycleFailure) Unwrap() error { return e.err }

type protocolFailure struct {
	err error
}

func (e *protocolFailure) Error() string { return e.err.Error() }
func (e *protocolFailure) Unwrap() error { return e.err }

// Connector consumes resumable export streams.
//
// Run maintains the following invariants:
//   - a request only carries the last durable acknowledged resume token;
//   - a batch token becomes durable only after Sink.ApplyBatch succeeds;
//   - records replayed at a resume boundary are filtered by record version;
//   - messages from another snapshot or connection generation are ignored;
//   - an invalid token starts a new snapshot, which is reconciled explicitly.
type Connector struct {
	opener    StreamOpener
	snapshots SnapshotStarter
	store     CheckpointStore
	sink      Sink
	retry     RetryPolicy
	sleep     func(context.Context, time.Duration) error

	mu      sync.Mutex
	running bool

	connections      atomic.Uint64
	staleBatches     atomic.Uint64
	duplicateRecords atomic.Uint64
	snapshotRestarts atomic.Uint64
}

// NewConnector validates cfg and returns a connector.
func NewConnector(cfg Config) (*Connector, error) {
	if cfg.Opener == nil {
		return nil, errors.New("dataeng: Config.Opener is required")
	}
	if cfg.Store == nil {
		return nil, errors.New("dataeng: Config.Store is required")
	}
	if cfg.Sink == nil {
		return nil, errors.New("dataeng: Config.Sink is required")
	}
	if cfg.Retry.InitialBackoff < 0 || cfg.Retry.MaxBackoff < 0 {
		return nil, errors.New("dataeng: retry backoff must not be negative")
	}
	if cfg.Retry == (RetryPolicy{}) {
		cfg.Retry = DefaultRetryPolicy()
	}

	return &Connector{
		opener:    cfg.Opener,
		snapshots: cfg.Snapshots,
		store:     cfg.Store,
		sink:      cfg.Sink,
		retry:     cfg.Retry,
		sleep:     sleepContext,
	}, nil
}

// Stats returns a point-in-time snapshot of connector activity.
func (c *Connector) Stats() Stats {
	return Stats{
		Connections:      c.connections.Load(),
		StaleBatches:     c.staleBatches.Load(),
		DuplicateRecords: c.duplicateRecords.Load(),
		SnapshotRestarts: c.snapshotRestarts.Load(),
	}
}

// Run streams until the snapshot completes, the context is cancelled, or a
// non-transport error occurs. Transport failures reconnect from the last
// acknowledged token. Calling Run again after an error resumes the same
// checkpoint.
func (c *Connector) Run(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !c.tryStart() {
		return ErrAlreadyRunning
	}
	defer c.finish()

	checkpoint, err := c.store.Load(ctx)
	if err != nil {
		return fmt.Errorf("dataeng: load checkpoint: %w", err)
	}
	if checkpoint.PendingReconcile != "" {
		return fmt.Errorf("%w: snapshot %s replaces %s",
			ErrReconciliationPending, checkpoint.SnapshotID, checkpoint.PendingReconcile)
	}
	if checkpoint.Complete {
		return nil
	}

	replacement := false
	replaces := ""
	baseSnapshotID := ""
	var base map[string]RecordRef

	reason := SnapshotResume
	if checkpoint.SnapshotID == "" {
		if c.snapshots == nil {
			return ErrNoSnapshotStarter
		}
		snapshot, err := c.snapshots.StartSnapshot(ctx, "")
		if err != nil {
			return fmt.Errorf("dataeng: start snapshot: %w", err)
		}
		if err := validateNewSnapshot(snapshot, ""); err != nil {
			return err
		}
		checkpoint = Checkpoint{
			SnapshotID:  snapshot.ID,
			ResumeToken: snapshot.ResumeToken,
		}
		reason = SnapshotInitial
	}

	state := newSnapshotState()
	event := SnapshotEvent{
		SnapshotID:  checkpoint.SnapshotID,
		ResumeToken: checkpoint.ResumeToken,
		Generation:  checkpoint.Generation,
		Reason:      reason,
	}
	if err := c.beginSnapshot(ctx, event); err != nil {
		return err
	}
	// Persist the snapshot before opening it. This makes a first-run
	// bootstrap restartable and binds the connection generation to a durable
	// snapshot identity.
	if err := c.store.Save(ctx, checkpoint); err != nil {
		return fmt.Errorf("dataeng: save checkpoint: %w", err)
	}

	failures := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := c.bumpGeneration(ctx, &checkpoint); err != nil {
			return err
		}

		stream, err := c.opener.Open(ctx, OpenRequest{
			SnapshotID:  checkpoint.SnapshotID,
			ResumeToken: checkpoint.ResumeToken,
			Generation:  checkpoint.Generation,
		})
		if err != nil {
			if errors.Is(err, ErrResumeTokenInvalid) {
				base, baseSnapshotID, state, checkpoint, replacement, replaces, err =
					c.replaceSnapshot(ctx, checkpoint, state, base, baseSnapshotID, replacement)
				if err != nil {
					return err
				}
				failures = 0
				continue
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			failures++
			if stop := c.stopAfterFailures(failures); stop {
				return fmt.Errorf("dataeng: open stream after %d attempts: %w", failures, err)
			}
			if err := c.wait(ctx, failures); err != nil {
				return err
			}
			continue
		}
		c.connections.Add(1)

		err = c.consume(ctx, stream, &checkpoint, state, &failures, replacement, replaces)
		_ = stream.Close()
		if err == nil {
			if err := c.completeSnapshot(ctx, checkpoint, reason, replacement, base, baseSnapshotID, state); err != nil {
				return err
			}
			return nil
		}

		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if errors.Is(err, ErrResumeTokenInvalid) {
			base, baseSnapshotID, state, checkpoint, replacement, replaces, err =
				c.replaceSnapshot(ctx, checkpoint, state, base, baseSnapshotID, replacement)
			if err != nil {
				return err
			}
			failures = 0
			continue
		}
		if isFatal(err) {
			return err
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}

		failures++
		if stop := c.stopAfterFailures(failures); stop {
			return fmt.Errorf("dataeng: stream after %d attempts: %w", failures, err)
		}
		if err := c.wait(ctx, failures); err != nil {
			return err
		}
	}
}

func (c *Connector) consume(
	ctx context.Context,
	stream Stream,
	checkpoint *Checkpoint,
	state *snapshotState,
	failures *int,
	replacement bool,
	replaces string,
) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		batch, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}

		if batch.SnapshotID != checkpoint.SnapshotID ||
			batch.Generation != checkpoint.Generation {
			c.staleBatches.Add(1)
			continue
		}

		records, refs, duplicates, err := state.selectNew(batch.Records)
		if err != nil {
			return &protocolFailure{
				err: fmt.Errorf("%w: %w", errProtocol, err),
			}
		}
		if duplicates > 0 {
			c.duplicateRecords.Add(uint64(duplicates))
		}

		if len(records) > 0 {
			delivered := DeliveredBatch{
				SnapshotID:  checkpoint.SnapshotID,
				Generation:  checkpoint.Generation,
				ResumeToken: batch.ResumeToken,
				Records:     records,
				Replacement: replacement,
				Replaces:    replaces,
			}
			if err := c.sink.ApplyBatch(ctx, delivered); err != nil {
				return &sinkFailure{err: err}
			}
			state.commit(records, refs)
		}

		// The token is persisted only after the sink confirms every new record
		// in this batch. Duplicate-only batches are safe to advance because
		// their records were confirmed by an earlier ApplyBatch call.
		if err := c.saveToken(ctx, checkpoint, batch.ResumeToken); err != nil {
			return err
		}
		if acker, ok := stream.(AckStream); ok {
			if err := acker.Ack(ctx, Ack{
				SnapshotID:  checkpoint.SnapshotID,
				ResumeToken: batch.ResumeToken,
				Generation:  checkpoint.Generation,
			}); err != nil {
				return fmt.Errorf("dataeng: acknowledge batch: %w", err)
			}
		}

		*failures = 0
	}
}

func (c *Connector) saveToken(ctx context.Context, checkpoint *Checkpoint, token string) error {
	if token == "" || token == checkpoint.ResumeToken {
		// Never regress to an empty token. An empty token is not a valid
		// recovery position once a snapshot has started.
		return nil
	}
	next := *checkpoint
	next.ResumeToken = token
	if err := c.store.Save(ctx, next); err != nil {
		return fmt.Errorf("dataeng: save resume token: %w", err)
	}
	*checkpoint = next
	return nil
}

func (c *Connector) bumpGeneration(ctx context.Context, checkpoint *Checkpoint) error {
	if checkpoint.Generation == ^uint64(0) {
		return errors.New("dataeng: connection generation exhausted")
	}
	next := *checkpoint
	next.Generation++
	if err := c.store.Save(ctx, next); err != nil {
		return fmt.Errorf("dataeng: save connection generation: %w", err)
	}
	*checkpoint = next
	return nil
}

func (c *Connector) replaceSnapshot(
	ctx context.Context,
	checkpoint Checkpoint,
	state *snapshotState,
	base map[string]RecordRef,
	baseSnapshotID string,
	replacement bool,
) (map[string]RecordRef, string, *snapshotState, Checkpoint, bool, string, error) {
	if c.snapshots == nil {
		return base, baseSnapshotID, state, checkpoint, replacement, "", ErrNoSnapshotStarter
	}

	abandoned := SnapshotEvent{
		SnapshotID:  checkpoint.SnapshotID,
		ResumeToken: checkpoint.ResumeToken,
		Generation:  checkpoint.Generation,
		Reason:      SnapshotReplacement,
		Replaces:    baseSnapshotID,
	}
	if replacement {
		if abandoner, ok := c.sink.(SnapshotAbandoner); ok {
			if err := abandoner.AbandonSnapshot(ctx, abandoned); err != nil {
				return base, baseSnapshotID, state, checkpoint, replacement, "", &lifecycleFailure{err: err}
			}
		}
	} else {
		base = state.manifestCopy()
		baseSnapshotID = checkpoint.SnapshotID
	}

	previousSnapshotID := checkpoint.SnapshotID
	snapshot, err := c.snapshots.StartSnapshot(ctx, previousSnapshotID)
	if err != nil {
		return base, baseSnapshotID, state, checkpoint, replacement, "", fmt.Errorf("dataeng: start replacement snapshot: %w", err)
	}
	if err := validateNewSnapshot(snapshot, checkpoint.SnapshotID); err != nil {
		return base, baseSnapshotID, state, checkpoint, replacement, "", err
	}

	next := Checkpoint{
		SnapshotID:  snapshot.ID,
		ResumeToken: snapshot.ResumeToken,
		Generation:  checkpoint.Generation,
	}
	if err := c.store.Save(ctx, next); err != nil {
		return base, baseSnapshotID, state, checkpoint, replacement, "", fmt.Errorf("dataeng: save replacement checkpoint: %w", err)
	}

	event := SnapshotEvent{
		SnapshotID:  next.SnapshotID,
		ResumeToken: next.ResumeToken,
		Generation:  next.Generation,
		Reason:      SnapshotReplacement,
		Replaces:    baseSnapshotID,
	}
	if err := c.beginSnapshot(ctx, event); err != nil {
		return base, baseSnapshotID, state, checkpoint, replacement, "", err
	}

	c.snapshotRestarts.Add(1)
	return base, baseSnapshotID, newSnapshotState(), next, true, baseSnapshotID, nil
}

func (c *Connector) completeSnapshot(
	ctx context.Context,
	checkpoint Checkpoint,
	reason SnapshotReason,
	replacement bool,
	base map[string]RecordRef,
	baseSnapshotID string,
	state *snapshotState,
) error {
	if replacement {
		reason = SnapshotReplacement
	}
	event := SnapshotEvent{
		SnapshotID:  checkpoint.SnapshotID,
		ResumeToken: checkpoint.ResumeToken,
		Generation:  checkpoint.Generation,
		Reason:      reason,
		Replaces:    baseSnapshotID,
	}
	if lifecycle, ok := c.sink.(SnapshotLifecycle); ok {
		if err := lifecycle.EndSnapshot(ctx, event); err != nil {
			return &lifecycleFailure{err: err}
		}
	}

	if replacement {
		pending := checkpoint
		pending.PendingReconcile = baseSnapshotID
		if err := c.store.Save(ctx, pending); err != nil {
			return fmt.Errorf("dataeng: save pending reconciliation: %w", err)
		}
		result := reconcile(baseSnapshotID, checkpoint.SnapshotID, base, state.manifest)
		if err := c.sink.Reconcile(ctx, result); err != nil {
			return &sinkFailure{err: err}
		}
	}

	next := checkpoint
	next.Complete = true
	next.PendingReconcile = ""
	if err := c.store.Save(ctx, next); err != nil {
		return fmt.Errorf("dataeng: save completed checkpoint: %w", err)
	}
	return nil
}

func (c *Connector) beginSnapshot(ctx context.Context, event SnapshotEvent) error {
	if lifecycle, ok := c.sink.(SnapshotLifecycle); ok {
		if err := lifecycle.BeginSnapshot(ctx, event); err != nil {
			return &lifecycleFailure{err: err}
		}
	}
	return nil
}

func (c *Connector) wait(ctx context.Context, failures int) error {
	policy := c.retry
	delay := policy.InitialBackoff
	for i := 1; i < failures && delay > 0; i++ {
		if delay > (1<<62)/2 {
			break
		}
		delay *= 2
		if policy.MaxBackoff > 0 && delay > policy.MaxBackoff {
			delay = policy.MaxBackoff
			break
		}
	}
	if policy.MaxBackoff > 0 && delay > policy.MaxBackoff {
		delay = policy.MaxBackoff
	}
	return c.sleep(ctx, delay)
}

func (c *Connector) stopAfterFailures(failures int) bool {
	return c.retry.MaxAttempts > 0 && failures >= c.retry.MaxAttempts
}

func (c *Connector) tryStart() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.running {
		return false
	}
	c.running = true
	return true
}

func (c *Connector) finish() {
	c.mu.Lock()
	c.running = false
	c.mu.Unlock()
}

func validateNewSnapshot(snapshot Snapshot, previous string) error {
	if snapshot.ID == "" {
		return fmt.Errorf("%w: empty snapshot id", ErrInvalidSnapshot)
	}
	if snapshot.ID == previous {
		return fmt.Errorf("%w: snapshot id %q was reused", ErrInvalidSnapshot, snapshot.ID)
	}
	return nil
}

func isFatal(err error) bool {
	var sinkErr *sinkFailure
	var lifecycleErr *lifecycleFailure
	var protocolErr *protocolFailure
	return errors.As(err, &sinkErr) ||
		errors.As(err, &lifecycleErr) ||
		errors.As(err, &protocolErr)
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
