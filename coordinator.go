package dataeng

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Coordinator owns the processing workers for the partitions currently
// assigned to this consumer-group member.
type Coordinator struct {
	cfg Config

	mu     sync.Mutex
	parts  map[PartitionID]*partitionState
	closed bool

	baseCtx     context.Context
	baseCancel  context.CancelFunc
	wg          sync.WaitGroup
	closeOnce   sync.Once
	journalOnce sync.Once
	journalErr  error
}

type partitionState struct {
	id PartitionID

	// opMu serializes assignment and revocation for this partition. Lost is
	// deliberately lock-free: it must fence an old owner immediately.
	opMu sync.Mutex

	mu              sync.Mutex
	epoch           uint64
	generation      int64
	next            Offset
	watermark       Offset
	active          bool
	revoking        bool
	lastErr         error
	cancel          context.CancelFunc
	workerDone      chan struct{}
	workerRunning   bool
	inflight        int
	drained         chan struct{}
	inflightBatches map[string]uint64
}

// New builds a coordinator from cfg. Journal replay happens lazily when a
// partition is assigned, because offsets may only be committed while the
// consumer group owns the partition.
func New(cfg Config) (*Coordinator, error) {
	cfg.setDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(cfg.BaseContext)
	return &Coordinator{
		cfg:        cfg,
		parts:      make(map[PartitionID]*partitionState),
		baseCtx:    ctx,
		baseCancel: cancel,
	}, nil
}

// Assigned is the rebalance-listener spelling of [Coordinator.Assign].
func (c *Coordinator) Assigned(ctx context.Context, assignments []Assignment) error {
	return c.Assign(ctx, assignments...)
}

// Assign grants ownership of the supplied partitions and starts their
// workers. Assignments are incremental: partitions not mentioned keep
// running, which is what cooperative-sticky rebalancing requires.
//
// If a partition is still owned, the previous lease is fenced first. Pending
// transactions found in the journal are completed before the new worker
// starts fetching.
func (c *Coordinator) Assign(ctx context.Context, assignments ...Assignment) error {
	for _, assignment := range assignments {
		if err := c.assignOne(ctx, assignment); err != nil {
			return err
		}
	}
	return nil
}

func (c *Coordinator) assignOne(ctx context.Context, assignment Assignment) error {
	if assignment.NextOffset < 0 {
		return fmt.Errorf("dataeng: negative next offset for partition %d", assignment.Partition)
	}
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return ErrClosed
	}
	p := c.partition(assignment.Partition)

	p.opMu.Lock()
	defer p.opMu.Unlock()

	p.mu.Lock()
	if p.active {
		// Fence the previous lease before installing the new one. Its worker
		// may still be blocked in a sink callback; that callback will be
		// rejected when it arrives.
		if p.cancel != nil {
			p.cancel()
		}
		p.active = false
		p.revoking = false
		p.epoch++
	}
	p.epoch++
	epoch := p.epoch
	p.generation = assignment.Generation
	p.next = assignment.NextOffset
	p.watermark = assignment.NextOffset
	p.lastErr = nil
	p.revoking = false
	if p.drained == nil {
		p.drained = make(chan struct{})
		close(p.drained)
	}
	p.mu.Unlock()

	// Let an offset commit that already passed its lease check finish before
	// a new epoch can issue another one.
	if err := p.waitDrained(ctx); err != nil {
		return fmt.Errorf("dataeng: assign partition %d: %w", assignment.Partition, err)
	}

	lease := Lease{Partition: assignment.Partition, Generation: assignment.Generation, Epoch: epoch}
	start, err := c.recoverPartition(ctx, p, lease, assignment.NextOffset)
	if err != nil {
		p.fail(lease, err)
		return fmt.Errorf("dataeng: recover partition %d: %w", assignment.Partition, err)
	}

	p.mu.Lock()
	if p.epoch != lease.Epoch {
		p.mu.Unlock()
		return ErrStaleLease
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		p.mu.Unlock()
		return ErrClosed
	}
	c.wg.Add(1)
	c.mu.Unlock()
	p.next = start
	p.watermark = start
	p.active = true
	p.ctxCancelLocked()
	workerCtx, cancel := context.WithCancel(c.baseCtx)
	p.cancel = cancel
	p.workerDone = make(chan struct{})
	p.workerRunning = true
	done := p.workerDone
	p.mu.Unlock()

	go c.runWorker(p, lease, workerCtx, done)
	return nil
}

func (p *partitionState) ctxCancelLocked() {
	if p.cancel != nil {
		p.cancel()
	}
}

// Revoked is the rebalance-listener spelling of [Coordinator.Revoke].
func (c *Coordinator) Revoked(ctx context.Context, partitions []PartitionID) error {
	return c.Revoke(ctx, partitions...)
}

// Revoke relinquishes ownership of the supplied partitions.
//
// Revoke stops new fetches for each partition and waits for its in-flight
// batch, including the sink callback and offset commit, to finish. If the
// context expires first, the lease is fenced immediately and
// [ErrRevokeTimeout] is returned. A callback that arrives after that fencing
// is journaled but cannot advance the next owner's watermark.
func (c *Coordinator) Revoke(ctx context.Context, partitions ...PartitionID) error {
	for _, partition := range partitions {
		if err := c.revokeOne(ctx, partition); err != nil {
			return err
		}
	}
	return nil
}

func (c *Coordinator) revokeOne(ctx context.Context, partition PartitionID) error {
	c.mu.Lock()
	p := c.parts[partition]
	c.mu.Unlock()
	if p == nil {
		return nil
	}

	p.opMu.Lock()
	defer p.opMu.Unlock()

	p.mu.Lock()
	if !p.active && !p.workerRunning {
		p.mu.Unlock()
		return nil
	}
	p.revoking = true
	if p.cancel != nil {
		p.cancel()
	}
	done := p.workerDone
	p.mu.Unlock()

	waitCtx := ctx
	cancel := func() {}
	if _, ok := ctx.Deadline(); !ok {
		waitCtx, cancel = context.WithTimeout(ctx, c.cfg.RevokeTimeout)
	}
	defer cancel()

	select {
	case <-done:
		p.mu.Lock()
		p.active = false
		p.revoking = false
		p.workerRunning = false
		p.epoch++ // fence any late duplicate callback from this lease
		p.mu.Unlock()
		return nil
	case <-waitCtx.Done():
		p.mu.Lock()
		p.active = false
		p.revoking = false
		p.workerRunning = false
		p.epoch++ // refuse further commits from the old owner
		p.mu.Unlock()
		return fmt.Errorf("%w: partition %d: %v", ErrRevokeTimeout, partition, waitCtx.Err())
	}
}

// Lost fences the supplied partitions without waiting. It is used when the
// consumer group reports that ownership was lost without a clean revoke.
func (c *Coordinator) Lost(partitions ...PartitionID) {
	for _, partition := range partitions {
		c.mu.Lock()
		p := c.parts[partition]
		c.mu.Unlock()
		if p == nil {
			continue
		}
		p.mu.Lock()
		if p.cancel != nil {
			p.cancel()
		}
		p.active = false
		p.revoking = false
		p.workerRunning = false
		p.epoch++
		p.mu.Unlock()
	}
}

func (c *Coordinator) runWorker(p *partitionState, lease Lease, ctx context.Context, done chan struct{}) {
	owned := make(map[string]struct{})
	defer c.wg.Done()
	defer close(done)
	defer func() {
		p.mu.Lock()
		if p.epoch == lease.Epoch {
			p.workerRunning = false
		}
		for id := range owned {
			if p.inflightBatches[id] == lease.Epoch {
				delete(p.inflightBatches, id)
			}
		}
		p.mu.Unlock()
	}()

	for {
		if !p.owns(lease) {
			return
		}
		from, ok := p.cursor(lease)
		if !ok {
			return
		}

		records, err := c.cfg.Reader.Fetch(ctx, p.id, from, c.cfg.BatchSize)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			p.fail(lease, fmt.Errorf("fetch partition %d: %w", p.id, err))
			return
		}
		if !p.owns(lease) {
			return
		}
		if len(records) == 0 {
			if !sleepContext(ctx, c.cfg.PollInterval) {
				return
			}
			continue
		}
		if len(records) > c.cfg.BatchSize {
			p.fail(lease, fmt.Errorf("reader returned %d records, limit is %d", len(records), c.cfg.BatchSize))
			return
		}
		if err := validateRecords(p.id, from, records); err != nil {
			p.fail(lease, err)
			return
		}

		output, err := c.cfg.Processor.Process(ctx, records)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			p.fail(lease, fmt.Errorf("process partition %d: %w", p.id, err))
			return
		}
		if !p.owns(lease) {
			return
		}

		next := records[len(records)-1].Offset + 1
		batch := Batch{
			ID:          newBatchID(p.id, from, next),
			Partition:   p.id,
			FirstOffset: from,
			NextOffset:  next,
			Records:     output,
		}
		if err := batch.Validate(); err != nil {
			p.fail(lease, err)
			return
		}
		if err := c.cfg.Journal.Append(ctx, beginEvent(lease, batch)); err != nil {
			if ctx.Err() != nil {
				return
			}
			p.fail(lease, fmt.Errorf("journal begin for %s: %w", batch.ID, err))
			return
		}
		p.mu.Lock()
		p.inflightBatches[batch.ID] = lease.Epoch
		p.mu.Unlock()
		owned[batch.ID] = struct{}{}

		// From this point on the batch is in flight. A revoke must wait for
		// it, so do not derive the commit context from the fetch context.
		commitCtx, commitCancel := context.WithTimeout(context.WithoutCancel(ctx), c.cfg.CommitTimeout)
		outcome := make(chan commitOutcome, 1)
		err = c.cfg.Sink.Submit(commitCtx, batch, func(receipt Receipt, err error) {
			outcome <- commitOutcome{receipt: receipt, err: err}
		})
		if err != nil {
			commitCancel()
			c.dropInflightBatch(p, lease, batch.ID)
			delete(owned, batch.ID)
			p.fail(lease, fmt.Errorf("submit batch %s: %w", batch.ID, err))
			return
		}
		var result commitOutcome
		select {
		case result = <-outcome:
		case <-commitCtx.Done():
			result.err = fmt.Errorf("sink commit for %s: %w", batch.ID, commitCtx.Err())
		}
		if result.err != nil {
			commitCancel()
			c.dropInflightBatch(p, lease, batch.ID)
			delete(owned, batch.ID)
			p.fail(lease, result.err)
			return
		}
		if err := c.finishBatch(commitCtx, p, lease, batch, result.receipt); err != nil {
			commitCancel()
			c.dropInflightBatch(p, lease, batch.ID)
			delete(owned, batch.ID)
			if errors.Is(err, ErrStaleLease) {
				return
			}
			p.fail(lease, err)
			return
		}
		commitCancel()
		c.dropInflightBatch(p, lease, batch.ID)
		delete(owned, batch.ID)
	}
}

func (c *Coordinator) dropInflightBatch(p *partitionState, lease Lease, id string) {
	p.mu.Lock()
	if p.inflightBatches[id] == lease.Epoch {
		delete(p.inflightBatches, id)
	}
	p.mu.Unlock()
}

type commitOutcome struct {
	receipt Receipt
	err     error
}

func (c *Coordinator) finishBatch(ctx context.Context, p *partitionState, lease Lease, batch Batch, receipt Receipt) error {
	if err := c.cfg.Journal.Append(ctx, Event{
		Kind:       EventSinkCommitted,
		BatchID:    batch.ID,
		Partition:  batch.Partition,
		Generation: lease.Generation,
		Epoch:      lease.Epoch,
		First:      batch.FirstOffset,
		Next:       batch.NextOffset,
		Receipt:    receipt,
	}); err != nil {
		return fmt.Errorf("journal sink commit for %s: %w", batch.ID, err)
	}

	p.mu.Lock()
	if p.epoch != lease.Epoch || p.generation != lease.Generation {
		p.mu.Unlock()
		_ = c.cfg.Journal.Append(ctx, Event{
			Kind:       EventFenced,
			BatchID:    batch.ID,
			Partition:  batch.Partition,
			Generation: lease.Generation,
			Epoch:      lease.Epoch,
			First:      batch.FirstOffset,
			Next:       batch.NextOffset,
			Receipt:    receipt,
			Reason:     "sink callback arrived after lease was fenced",
		})
		return ErrStaleLease
	}
	p.inflight++
	if p.inflight == 1 {
		p.drained = make(chan struct{})
	}
	p.mu.Unlock()

	err := c.cfg.Committer.CommitOffset(ctx, batch.Partition, batch.NextOffset)

	p.mu.Lock()
	p.inflight--
	if p.inflight == 0 {
		close(p.drained)
	}
	if err == nil && p.epoch == lease.Epoch {
		if batch.NextOffset > p.watermark {
			p.watermark = batch.NextOffset
		}
		if batch.NextOffset > p.next {
			p.next = batch.NextOffset
		}
	}
	p.mu.Unlock()

	if err != nil {
		return fmt.Errorf("commit offset for %s: %w", batch.ID, err)
	}
	if err := c.cfg.Journal.Append(ctx, Event{
		Kind:       EventOffsetCommitted,
		BatchID:    batch.ID,
		Partition:  batch.Partition,
		Generation: lease.Generation,
		Epoch:      lease.Epoch,
		First:      batch.FirstOffset,
		Next:       batch.NextOffset,
	}); err != nil {
		return fmt.Errorf("journal offset commit for %s: %w", batch.ID, err)
	}
	return nil
}

func beginEvent(lease Lease, batch Batch) Event {
	return Event{
		Kind:       EventBegin,
		BatchID:    batch.ID,
		Partition:  batch.Partition,
		Generation: lease.Generation,
		Epoch:      lease.Epoch,
		First:      batch.FirstOffset,
		Next:       batch.NextOffset,
		Output:     batch.Records,
	}
}

func (p *partitionState) owns(lease Lease) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active && !p.revoking && p.epoch == lease.Epoch && p.generation == lease.Generation
}

func (p *partitionState) current(lease Lease) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.epoch == lease.Epoch && p.generation == lease.Generation
}

func (p *partitionState) cursor(lease Lease) (Offset, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.active || p.revoking || p.epoch != lease.Epoch || p.generation != lease.Generation {
		return 0, false
	}
	return p.next, true
}

func (p *partitionState) fail(lease Lease, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.epoch == lease.Epoch {
		p.lastErr = err
		p.active = false
		p.revoking = false
	}
}

func (p *partitionState) waitDrained(ctx context.Context) error {
	for {
		p.mu.Lock()
		if p.inflight == 0 {
			p.mu.Unlock()
			return nil
		}
		drained := p.drained
		p.mu.Unlock()
		select {
		case <-drained:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Watermark reports the highest next offset that has been committed for the
// current or most recent lease of partition.
func (c *Coordinator) Watermark(partition PartitionID) (Offset, bool) {
	c.mu.Lock()
	p := c.parts[partition]
	c.mu.Unlock()
	if p == nil {
		return 0, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.watermark, true
}

// Status reports a snapshot for one partition.
func (c *Coordinator) Status(partition PartitionID) (Status, bool) {
	c.mu.Lock()
	p := c.parts[partition]
	c.mu.Unlock()
	if p == nil {
		return Status{}, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return Status{
		Partition:  p.id,
		Generation: p.generation,
		Epoch:      p.epoch,
		Next:       p.next,
		Watermark:  p.watermark,
		Active:     p.active,
		Revoking:   p.revoking,
		LastError:  p.lastErr,
	}, true
}

// Statuses reports snapshots for every partition seen by the coordinator.
func (c *Coordinator) Statuses() []Status {
	c.mu.Lock()
	parts := make([]*partitionState, 0, len(c.parts))
	for _, p := range c.parts {
		parts = append(parts, p)
	}
	c.mu.Unlock()
	out := make([]Status, 0, len(parts))
	for _, p := range parts {
		if status, ok := c.Status(p.id); ok {
			out = append(out, status)
		}
	}
	return out
}

// Close stops all workers and waits for in-flight commits until ctx expires.
func (c *Coordinator) Close(ctx context.Context) error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		parts := make([]*partitionState, 0, len(c.parts))
		for _, p := range c.parts {
			parts = append(parts, p)
		}
		c.mu.Unlock()

		c.baseCancel()
		for _, p := range parts {
			p.mu.Lock()
			if p.cancel != nil {
				p.cancel()
			}
			p.active = false
			p.revoking = false
			p.workerRunning = false
			p.epoch++
			p.mu.Unlock()
		}
	})

	allDone := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(allDone)
	}()
	select {
	case <-allDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	c.journalOnce.Do(func() {
		if closer, ok := c.cfg.Journal.(io.Closer); ok {
			if err := closer.Close(); err != nil {
				c.journalErr = fmt.Errorf("dataeng: close journal: %w", err)
			}
		}
	})
	return c.journalErr
}

func (c *Coordinator) partition(id PartitionID) *partitionState {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p := c.parts[id]; p != nil {
		return p
	}
	p := &partitionState{id: id, drained: make(chan struct{}), inflightBatches: make(map[string]uint64)}
	close(p.drained)
	c.parts[id] = p
	return p
}

func validateRecords(partition PartitionID, from Offset, records []Record) error {
	expected := from
	for _, record := range records {
		if record.Partition != partition {
			return fmt.Errorf("dataeng: fetch for partition %d returned record for partition %d", partition, record.Partition)
		}
		if record.Offset != expected {
			return fmt.Errorf("dataeng: partition %d offset gap: want %d, got %d", partition, expected, record.Offset)
		}
		expected++
	}
	return nil
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
