package dataeng

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Clock supplies time for lease expiry and renewals.
type Clock interface {
	Now() time.Time
}

// ClockFunc adapts a function to Clock.
type ClockFunc func() time.Time

func (f ClockFunc) Now() time.Time { return f() }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// Progress is one atomic watermark/output-acknowledgement advance.
type Progress struct {
	// Watermark is the last input sequence number processed.
	Watermark SequenceNumber
	// OutputAck is the last sequence number whose output was confirmed durable
	// downstream. It may trail Watermark but never lead it.
	OutputAck SequenceNumber
	// Final asks the coordinator to validate that the closed shard is fully
	// consumed and acknowledged. Completion is also inferred when both
	// positions reach a closed shard's ending sequence number, so callers need
	// not race a separate finalize call.
	Final bool
}

// Readiness is a scheduler-facing view of whether a shard's dependencies are
// satisfied. An active lease is visible in State; Acquire reports it as
// LeaseHeldError rather than making the dependency readiness false.
type Readiness struct {
	Shard          Shard
	State          Record
	Closed         bool
	Completed      bool
	Ready          bool
	MissingParents []ShardID
	PendingParents []ShardID
}

// Report is a complete snapshot of the observed graph and its readiness.
type Report struct {
	GeneratedAt    time.Time
	Shards         []Readiness
	MissingParents []MissingParent
}

// ReadyShardIDs returns the ready shards from the report.
func (r Report) ReadyShardIDs() []ShardID {
	ids := make([]ShardID, 0, len(r.Shards))
	for _, status := range r.Shards {
		if status.Ready {
			ids = append(ids, status.Shard.ShardID)
		}
	}
	return ids
}

// ShardScheduler is the interface a DynamoDB Streams collector or scheduler
// can consume directly.
type ShardScheduler interface {
	Observe(shards ...Shard) error
	ReadyShards(ctx context.Context) ([]ShardID, error)
	Acquire(ctx context.Context, shardID ShardID, workerID string) (Lease, error)
	Renew(ctx context.Context, lease Lease) (Lease, error)
	Release(ctx context.Context, lease Lease) error
	Commit(ctx context.Context, lease Lease, progress Progress) (Record, error)
}

var _ ShardScheduler = (*Coordinator)(nil)

// Option configures a Coordinator.
type Option func(*Coordinator)

// WithLeaseTTL sets the default duration of newly acquired leases.
func WithLeaseTTL(ttl time.Duration) Option {
	return func(c *Coordinator) {
		if ttl > 0 {
			c.leaseTTL = ttl
		}
	}
}

// WithClock replaces the wall clock, primarily for deterministic tests.
func WithClock(clock Clock) Option {
	return func(c *Coordinator) {
		if clock != nil {
			c.clock = clock
		}
	}
}

// WithGraph uses a caller-owned graph so shard observations can be shared.
func WithGraph(graph *ShardGraph) Option {
	return func(c *Coordinator) {
		if graph != nil {
			c.graph = graph
		}
	}
}

const defaultLeaseTTL = 30 * time.Second

// Coordinator combines a reshard graph with atomic shard state. A nil store
// uses a new MemoryStore.
type Coordinator struct {
	graph    *ShardGraph
	store    Store
	clock    Clock
	leaseTTL time.Duration
}

// NewCoordinator creates a coordinator. Options are applied in order.
func NewCoordinator(store Store, opts ...Option) *Coordinator {
	if store == nil {
		store = NewMemoryStore()
	}
	c := &Coordinator{
		graph:    &ShardGraph{shards: make(map[ShardID]Shard)},
		store:    store,
		clock:    systemClock{},
		leaseTTL: defaultLeaseTTL,
	}
	for _, option := range opts {
		if option != nil {
			option(c)
		}
	}
	return c
}

// Collector is an alias for Coordinator.
type Collector = Coordinator

// NewCollector is an alias for NewCoordinator.
func NewCollector(store Store, opts ...Option) *Collector {
	return NewCoordinator(store, opts...)
}

// Graph exposes the shared reshard graph.
func (c *Coordinator) Graph() *ShardGraph { return c.graph }

// Store exposes the durable state boundary.
func (c *Coordinator) Store() Store { return c.store }

// LeaseTTL returns the default lease duration.
func (c *Coordinator) LeaseTTL() time.Duration { return c.leaseTTL }

// Observe merges shard descriptions into the reshard graph.
func (c *Coordinator) Observe(shards ...Shard) error {
	return c.graph.AddAll(shards...)
}

// Readiness reports whether a shard can be leased. Missing parents and
// unfinished parents are both reported. An unknown shard returns
// ErrShardNotFound.
func (c *Coordinator) Readiness(ctx context.Context, shardID ShardID) (Readiness, error) {
	shard, ok := c.graph.Shard(shardID)
	if !ok {
		return Readiness{}, fmt.Errorf("%w: %q", ErrShardNotFound, shardID)
	}
	state, err := c.load(ctx, shardID)
	if err != nil {
		return Readiness{}, err
	}
	missing, pending, err := c.parentStatus(ctx, shard)
	if err != nil {
		return Readiness{}, err
	}
	completed := state.Completed
	readiness := Readiness{
		Shard:          shard,
		State:          state,
		Closed:         shard.Closed(),
		Completed:      completed,
		MissingParents: missing,
		PendingParents: pending,
	}
	readiness.Ready = !completed && len(missing) == 0 && len(pending) == 0
	return readiness, nil
}

func (c *Coordinator) parentStatus(
	ctx context.Context,
	shard Shard,
) (missing []ShardID, pending []ShardID, err error) {
	parents := shard.ParentIDs()
	for _, parentID := range parents {
		if !c.graph.Has(parentID) {
			missing = append(missing, parentID)
			continue
		}
		parent, err := c.load(ctx, parentID)
		if err != nil {
			return nil, nil, err
		}
		if !parent.Completed {
			pending = append(pending, parentID)
		}
	}
	if len(missing) > 0 {
		sort.Slice(missing, func(i, j int) bool { return missing[i] < missing[j] })
	}
	if len(pending) > 0 {
		sort.Slice(pending, func(i, j int) bool { return pending[i] < pending[j] })
	}
	return missing, pending, nil
}

// ReadyShards lists shards that may be leased now.
func (c *Coordinator) ReadyShards(ctx context.Context) ([]ShardID, error) {
	report, err := c.Report(ctx)
	if err != nil {
		return nil, err
	}
	return report.ReadyShardIDs(), nil
}

// Report snapshots every known shard and all absent parent links.
func (c *Coordinator) Report(ctx context.Context) (Report, error) {
	shards := c.graph.Shards()
	statuses := make([]Readiness, 0, len(shards))
	for _, shard := range shards {
		status, err := c.Readiness(ctx, shard.ShardID)
		if err != nil {
			return Report{}, err
		}
		statuses = append(statuses, status)
	}
	return Report{
		GeneratedAt:    c.clock.Now(),
		Shards:         statuses,
		MissingParents: c.graph.MissingParents(),
	}, nil
}

// State returns a shard's current durable state.
func (c *Coordinator) State(ctx context.Context, shardID ShardID) (Record, error) {
	if !c.graph.Has(shardID) {
		return Record{}, fmt.Errorf("%w: %q", ErrShardNotFound, shardID)
	}
	return c.load(ctx, shardID)
}

// Acquire leases a ready shard under a new generation. A child whose parent is
// missing or incomplete is rejected before any state is written.
func (c *Coordinator) Acquire(
	ctx context.Context,
	shardID ShardID,
	workerID string,
) (Lease, error) {
	return c.AcquireFor(ctx, shardID, workerID, c.leaseTTL)
}

// AcquireFor is Acquire with an explicit lease duration.
func (c *Coordinator) AcquireFor(
	ctx context.Context,
	shardID ShardID,
	workerID string,
	ttl time.Duration,
) (Lease, error) {
	workerID = strings.TrimSpace(workerID)
	if workerID == "" {
		return Lease{}, ErrEmptyWorkerID
	}
	if ttl <= 0 {
		return Lease{}, ErrInvalidLeaseTTL
	}
	readiness, err := c.Readiness(ctx, shardID)
	if err != nil {
		return Lease{}, err
	}
	switch {
	case readiness.Completed:
		return Lease{}, fmt.Errorf("%w: %q", ErrShardCompleted, shardID)
	case len(readiness.MissingParents) > 0:
		return Lease{}, &MissingParentsError{
			ShardID: shardID,
			Parents: readiness.MissingParents,
		}
	case len(readiness.PendingParents) > 0:
		return Lease{}, &PendingParentsError{
			ShardID: shardID,
			Parents: readiness.PendingParents,
		}
	case !readiness.Ready:
		return Lease{}, fmt.Errorf("%w: %q", ErrShardNotReady, shardID)
	}

	var acquired Lease
	_, err = c.mutate(ctx, shardID, func(record *Record, _ bool) (bool, error) {
		now := c.clock.Now()
		if record.Completed {
			return false, fmt.Errorf("%w: %q", ErrShardCompleted, shardID)
		}
		if !record.Lease.Expired(now) {
			if record.Lease.Owner == workerID {
				acquired = record.Lease
				return false, nil
			}
			return false, &LeaseHeldError{ShardID: shardID, Lease: record.Lease}
		}
		if record.Generation == math.MaxUint64 {
			return false, fmt.Errorf("dataeng: lease generation overflow for %q", shardID)
		}
		record.Generation++
		record.Lease = Lease{
			ShardID:    shardID,
			Owner:      workerID,
			Generation: record.Generation,
			ExpiresAt:  now.Add(ttl),
		}
		acquired = record.Lease
		return true, nil
	})
	if err != nil {
		return Lease{}, err
	}
	return acquired, nil
}

// Renew extends the current lease without changing its generation. An expired
// lease cannot be renewed; the worker must acquire again and receive a new
// generation.
func (c *Coordinator) Renew(ctx context.Context, lease Lease) (Lease, error) {
	return c.RenewFor(ctx, lease, c.leaseTTL)
}

// RenewFor is Renew with an explicit lease duration.
func (c *Coordinator) RenewFor(
	ctx context.Context,
	lease Lease,
	ttl time.Duration,
) (Lease, error) {
	if ttl <= 0 {
		return Lease{}, ErrInvalidLeaseTTL
	}
	if err := lease.validate(lease.ShardID); err != nil {
		return Lease{}, err
	}
	var renewed Lease
	_, err := c.mutate(ctx, lease.ShardID, func(record *Record, _ bool) (bool, error) {
		now := c.clock.Now()
		if err := activeLeaseError(record, lease, now); err != nil {
			return false, fmt.Errorf("%w: shard %q", err, lease.ShardID)
		}
		record.Lease.ExpiresAt = now.Add(ttl)
		renewed = record.Lease
		return true, nil
	})
	if err != nil {
		return Lease{}, err
	}
	return renewed, nil
}

// Release surrenders a lease while retaining the generation counter, so the
// next acquisition still issues a newer generation.
func (c *Coordinator) Release(ctx context.Context, lease Lease) error {
	if err := lease.validate(lease.ShardID); err != nil {
		return err
	}
	_, err := c.mutate(ctx, lease.ShardID, func(record *Record, _ bool) (bool, error) {
		if !leaseMatches(record, lease) {
			return false, fmt.Errorf("%w: shard %q", ErrLeaseLost, lease.ShardID)
		}
		record.Lease = Lease{}
		return true, nil
	})
	return err
}

// Commit atomically advances the input watermark and downstream output
// acknowledgement. A closed shard completes in the same swap once both
// positions reach its ending sequence number. Rejected final commits leave the
// record untouched, so a caller can retry after acknowledging remaining
// output.
func (c *Coordinator) Commit(
	ctx context.Context,
	lease Lease,
	progress Progress,
) (Record, error) {
	if err := lease.validate(lease.ShardID); err != nil {
		return Record{}, err
	}
	shard, ok := c.graph.Shard(lease.ShardID)
	if !ok {
		return Record{}, fmt.Errorf("%w: %q", ErrShardNotFound, lease.ShardID)
	}
	committed, err := c.mutate(ctx, shard.ShardID, func(record *Record, _ bool) (bool, error) {
		now := c.clock.Now()
		if err := activeLeaseError(record, lease, now); err != nil {
			return false, fmt.Errorf("%w: shard %q", err, shard.ShardID)
		}
		next, err := validateProgress(record, shard, progress, now)
		if err != nil {
			return false, err
		}
		*record = next
		return true, nil
	})
	if err != nil {
		return Record{}, err
	}
	return committed, nil
}

// Complete is a convenience wrapper for a final commit.
func (c *Coordinator) Complete(
	ctx context.Context,
	lease Lease,
	watermark, outputAck SequenceNumber,
) (Record, error) {
	return c.Commit(ctx, lease, Progress{
		Watermark: watermark,
		OutputAck: outputAck,
		Final:     true,
	})
}

func validateProgress(
	record *Record,
	shard Shard,
	progress Progress,
	now time.Time,
) (Record, error) {
	watermark := SequenceNumber(strings.TrimSpace(string(progress.Watermark)))
	outputAck := SequenceNumber(strings.TrimSpace(string(progress.OutputAck)))
	if watermark == "" {
		return Record{}, ErrInvalidWatermark
	}
	if outputAck == "" {
		return Record{}, ErrInvalidOutputAck
	}
	if err := requireNonDecreasing("watermark", record.Watermark, watermark); err != nil {
		return Record{}, err
	}
	if err := requireNonDecreasing("output acknowledgement", record.OutputAck, outputAck); err != nil {
		return Record{}, err
	}
	if cmp, ok := watermark.Compare(outputAck); ok && cmp < 0 {
		return Record{}, fmt.Errorf("%w: watermark %q, output ack %q",
			ErrAckAheadOfWatermark, watermark, outputAck)
	}

	atEnd := false
	if shard.Closed() {
		ending := shard.EndingSequenceNumber
		switch {
		case watermark == ending && outputAck == ending:
			atEnd = true
		default:
			watermarkCmp, watermarkOrdered := watermark.Compare(ending)
			ackCmp, ackOrdered := outputAck.Compare(ending)
			atEnd = watermarkOrdered && ackOrdered && watermarkCmp >= 0 && ackCmp >= 0
		}
	}
	if progress.Final && !shard.Closed() {
		return Record{}, fmt.Errorf("%w: %q", ErrShardNotClosed, shard.ShardID)
	}
	if progress.Final && !atEnd {
		return Record{}, &IncompleteCloseError{
			ShardID:     shard.ShardID,
			Ending:      shard.EndingSequenceNumber,
			Watermark:   watermark,
			OutputAck:   outputAck,
			ShardClosed: shard.Closed(),
		}
	}

	next := *record
	next.ShardID = shard.ShardID
	next.Watermark = watermark
	next.OutputAck = outputAck
	if atEnd {
		next.Completed = true
		next.CompletedAt = now
		next.Lease = Lease{}
	}
	return next, nil
}

func requireNonDecreasing(field string, previous, next SequenceNumber) error {
	if previous == "" {
		return nil
	}
	cmp, ok := next.Compare(previous)
	if ok && cmp < 0 {
		return fmt.Errorf("%w: %s moved from %q to %q",
			ErrProgressRegression, field, previous, next)
	}
	return nil
}

func leaseMatches(record *Record, lease Lease) bool {
	return record.Lease.Owner == lease.Owner &&
		record.Lease.Generation == lease.Generation &&
		record.Lease.ShardID == lease.ShardID
}

// activeLeaseError distinguishes a completed shard from a stale holder. After
// completion the lease owner is cleared, but the generation remains, so the
// worker that completed the shard observes ErrShardCompleted while any older
// generation observes ErrLeaseLost.
func activeLeaseError(record *Record, lease Lease, now time.Time) error {
	if record.Completed {
		if lease.Generation != 0 && lease.Generation == record.Generation {
			return ErrShardCompleted
		}
		return ErrLeaseLost
	}
	if !leaseMatches(record, lease) {
		return ErrLeaseLost
	}
	if record.Lease.Expired(now) {
		return ErrLeaseExpired
	}
	return nil
}

func (c *Coordinator) load(ctx context.Context, shardID ShardID) (Record, error) {
	record, ok, err := c.store.Load(ctx, shardID)
	if err != nil {
		return Record{}, err
	}
	if !ok {
		return Record{ShardID: shardID}, nil
	}
	return record, nil
}

const maxCompareAndSwapAttempts = 64

// mutate applies fn to a fresh snapshot and retries version conflicts. A false
// changed result skips the write (for idempotent reacquisition).
func (c *Coordinator) mutate(
	ctx context.Context,
	shardID ShardID,
	fn func(record *Record, existed bool) (changed bool, err error),
) (Record, error) {
	for attempt := 0; attempt < maxCompareAndSwapAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return Record{}, err
		}
		record, existed, err := c.store.Load(ctx, shardID)
		if err != nil {
			return Record{}, err
		}
		if !existed {
			record = Record{ShardID: shardID}
		}
		record.ShardID = shardID
		changed, err := fn(&record, existed)
		if err != nil {
			return Record{}, err
		}
		if !changed {
			return record, nil
		}
		expectedVersion := uint64(0)
		if existed {
			expectedVersion = record.Version
		}
		record.Version = expectedVersion + 1
		err = c.store.CompareAndSwap(ctx, shardID, expectedVersion, record)
		if err == nil {
			return record, nil
		}
		if !errors.Is(err, ErrVersionConflict) {
			return Record{}, err
		}
	}
	return Record{}, fmt.Errorf("%w: exhausted %d attempts for shard %q",
		ErrVersionConflict, maxCompareAndSwapAttempts, shardID)
}
