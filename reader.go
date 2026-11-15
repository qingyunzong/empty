package dataeng

import (
	"context"
	"errors"
	"fmt"
)

// txnState is the lifecycle state of a transaction instance.
type txnState int

const (
	txnOngoing txnState = iota
	txnCommitted
	txnAborted
	// txnPoisoned means the transaction lost records to truncation and must be
	// discarded entirely.
	txnPoisoned
)

// bufferedRecord wraps a record while it waits for the transaction outcome or
// for the partition head to become deliverable.
type bufferedRecord struct {
	record *Record
	txn    *txnInfo // nil for non-transactional records
	// skipped marks an aborted (or poisoned) record so the partition head can
	// advance over it without delivering it.
	skipped bool
}

// txnInfo tracks one transaction. A producer runs at most one active
// transaction at a time; after the control marker the instance is retained in
// the producer's finalized list until its buffered records are drained.
type txnInfo struct {
	producerID    int64
	producerEpoch int16
	state         txnState
	// partitions whose buffered queue currently contains records of this txn
	partitions map[int]struct{}
}

// producerState tracks the highest known epoch of a producer id and its
// transaction lifecycle.
type producerState struct {
	epoch int16
	// active is the current ongoing transaction, or nil between transactions.
	active *txnInfo
	// finalized retains ended transactions whose records may still be buffered.
	finalized []*txnInfo
}

// partitionState holds all per-partition reader state.
type partitionState struct {
	source PartitionSource

	// nextOffset is the next log offset to fetch.
	nextOffset int64
	// deliveredOffset is the last offset delivered to (or explicitly skipped
	// past) the caller; -1 means nothing yet.
	deliveredOffset int64
	// leaderEpoch of the most recently consumed batch; -1 until first batch.
	leaderEpoch int32
	// lso is the most recently advertised last stable offset; 0 disables it.
	lso int64
	// awaitingData is true after a truncation left the partition empty; the
	// next out-of-range fetch is then treated as "still empty" rather than a
	// new truncation event.
	awaitingData bool

	// queue is the in-order buffer of records whose offsets have been consumed
	// but not yet delivered/skipped.
	queue []*bufferedRecord

	// lastSeq is the last accepted producer sequence per (producer id, epoch)
	// on this partition.
	lastSeq map[producerKey]seqState
}

type producerKey struct {
	producerID int64
	epoch      int16
}

type seqState struct {
	seq  int32
	seen bool
}

// ReaderStats summarizes reader activity for observability and tests.
type ReaderStats struct {
	Delivered        int64
	AbortedRecords   int64
	DuplicateRecords int64
	Truncations      int64
	PoisonedTxns     int64
	OngoingTxns      int
	BufferedRecords  int
}

// Reader is a read-committed transactional batch reader. It is not safe for
// concurrent Poll calls; a single goroutine should drive it.
type Reader struct {
	partitions map[int]*partitionState
	producers  map[int64]*producerState

	checkpoint      CheckpointStore
	checkpointEvery int
	polls           int

	stats ReaderStats
}

// Option configures a Reader.
type Option func(*Reader)

// WithCheckpointStore attaches a persistent checkpoint store. Without one the
// reader keeps checkpoints in memory only and starts at offset zero (or the
// source's earliest retained offset).
func WithCheckpointStore(store CheckpointStore) Option {
	return func(r *Reader) { r.checkpoint = store }
}

// WithCheckpointInterval persists offsets every n output-producing polls. The
// default persists after every output poll.
func WithCheckpointInterval(n int) Option {
	return func(r *Reader) {
		if n > 0 {
			r.checkpointEvery = n
		}
	}
}

// NewReader builds a reader over the given partition sources and restores the
// last persisted offsets from the checkpoint store when one is configured.
func NewReader(ctx context.Context, sources []PartitionSource, opts ...Option) (*Reader, error) {
	r := &Reader{
		partitions:      make(map[int]*partitionState),
		producers:       make(map[int64]*producerState),
		checkpoint:      NewMemoryCheckpoint(),
		checkpointEvery: 1,
	}
	for _, opt := range opts {
		opt(r)
	}

	saved, err := r.checkpoint.Load(ctx)
	if err != nil {
		return nil, fmt.Errorf("dataeng: load checkpoint: %w", err)
	}

	for _, source := range sources {
		partition := source.Partition()
		if _, exists := r.partitions[partition]; exists {
			return nil, fmt.Errorf("%w: duplicate partition source %d", ErrCorruptLog, partition)
		}
		state := &partitionState{
			source:          source,
			nextOffset:      0,
			deliveredOffset: -1,
			leaderEpoch:     -1,
			lastSeq:         make(map[producerKey]seqState),
		}
		if offset, ok := saved[partition]; ok && offset >= 0 {
			// Checkpoints store the last delivered offset; fetching resumes at
			// the following offset.
			state.nextOffset = offset + 1
			state.deliveredOffset = offset
		}
		r.partitions[partition] = state
	}
	return r, nil
}

// Poll performs one fetch round across every partition, ingests all returned
// batches, finalizes any transactions whose markers arrived, and returns the
// records that became deliverable. The returned slice is empty (never nil on
// success) when no record reached a committed state.
//
// Records are emitted partition by partition in ascending partition id, and
// within a partition in ascending offset order. This ordering is identical to
// a sequential replay of the per-partition logs by offset, which keeps
// recovery output deterministic.
func (r *Reader) Poll(ctx context.Context) ([]*Record, error) {
	for _, partition := range sortedPartitions(r.partitions) {
		state := r.partitions[partition]
		if err := r.fetchPartition(ctx, state); err != nil {
			return nil, err
		}
	}

	out := r.drain()
	if len(out) > 0 {
		r.polls++
		if r.checkpointEvery > 0 && r.polls%r.checkpointEvery == 0 {
			if err := r.persistCheckpoint(ctx); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// Checkpoint forces the current delivered offsets to be persisted.
func (r *Reader) Checkpoint(ctx context.Context) error {
	return r.persistCheckpoint(ctx)
}

func (r *Reader) persistCheckpoint(ctx context.Context) error {
	offsets := make(map[int]int64, len(r.partitions))
	for partition, state := range r.partitions {
		if state.deliveredOffset >= 0 {
			offsets[partition] = state.deliveredOffset
		}
	}
	if err := r.checkpoint.Save(ctx, offsets); err != nil {
		return fmt.Errorf("dataeng: save checkpoint: %w", err)
	}
	return nil
}

// Stats returns a point-in-time snapshot of reader counters.
func (r *Reader) Stats() ReaderStats {
	stats := r.stats
	for _, producer := range r.producers {
		if producer.active != nil && producer.active.state == txnOngoing {
			stats.OngoingTxns++
		}
	}
	for _, state := range r.partitions {
		stats.BufferedRecords += len(state.queue)
	}
	return stats
}

// fetchPartition fetches all currently available batches and ingests them.
func (r *Reader) fetchPartition(ctx context.Context, state *partitionState) error {
	resp, err := state.source.Fetch(ctx, state.nextOffset)
	if err != nil {
		var outOfRange *OffsetOutOfRangeError
		if errors.As(err, &outOfRange) {
			if state.awaitingData {
				// The partition is still empty after a known truncation; wait
				// for new appends instead of emitting another truncation.
				return nil
			}
			return r.handleTruncation(ctx, state, outOfRange.Earliest)
		}
		return err
	}
	state.awaitingData = false
	if resp == nil {
		return nil
	}
	state.lso = resp.LastStableOffset
	for _, batch := range resp.Batches {
		if batch == nil {
			continue
		}
		if err := r.ingest(ctx, state, batch); err != nil {
			return err
		}
	}
	return nil
}

// ingest validates and stores one batch, advancing the partition's fetch
// position past it.
func (r *Reader) ingest(ctx context.Context, state *partitionState, batch *Batch) error {
	if batch.Partition != state.source.Partition() {
		return fmt.Errorf("%w: batch partition %d does not match source %d",
			ErrCorruptLog, batch.Partition, state.source.Partition())
	}

	// A leader epoch regression means the batch comes from a stale leader whose
	// history may have been truncated.
	if state.leaderEpoch >= 0 && batch.LeaderEpoch < state.leaderEpoch {
		earliest, _, err := state.source.ListOffsets(ctx)
		if err != nil {
			return fmt.Errorf("dataeng: list offsets after leader epoch regression: %w", err)
		}
		return r.handleTruncation(ctx, state, earliest)
	}

	// Offsets must be contiguous relative to everything consumed so far. A
	// forward gap means records vanished without an explicit truncation.
	if batch.BaseOffset != state.nextOffset {
		if batch.BaseOffset < state.nextOffset {
			// Re-fetch of already-consumed data: ignore idempotently. Custom
			// sources may seek backwards during recovery.
			return nil
		}
		return fmt.Errorf("%w: offset gap on partition %d, expected %d got %d",
			ErrCorruptLog, state.source.Partition(), state.nextOffset, batch.BaseOffset)
	}

	if batch.Control {
		if err := r.ingestControl(state, batch); err != nil {
			return err
		}
		state.nextOffset = batch.BaseOffset + 1
		state.leaderEpoch = batch.LeaderEpoch
		return nil
	}

	if err := r.ingestData(state, batch); err != nil {
		return err
	}
	state.leaderEpoch = batch.LeaderEpoch
	return nil
}
