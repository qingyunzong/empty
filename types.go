package dataeng

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// PartitionID identifies a Kafka partition.
type PartitionID int32

// Offset is a Kafka record offset. Offsets used by the coordinator are always
// "next offsets": the offset the reader will fetch next and the offset that
// would be committed to Kafka.
type Offset int64

// Record is one fetched Kafka record.
type Record struct {
	Partition PartitionID
	Offset    Offset
	Key       []byte
	Value     []byte
	Timestamp time.Time
}

// OutputRecord is one record produced by a [Processor].
type OutputRecord struct {
	Key   []byte `json:"key,omitempty"`
	Value []byte `json:"value,omitempty"`
}

// Batch is the unit of exactly-once hand-off between the coordinator and an
// external sink.
//
// ID is stable across retries and ownership changes. It is derived only from
// the partition and the half-open offset range, never from an epoch, so the
// same input range always produces the same ID. A sink must treat ID as its
// idempotency key and must not apply the same batch twice.
type Batch struct {
	ID          string
	Partition   PartitionID
	FirstOffset Offset
	NextOffset  Offset
	Records     []OutputRecord
}

// Validate checks the structural invariants of a batch.
func (b Batch) Validate() error {
	if b.ID == "" {
		return errors.New("dataeng: batch has no id")
	}
	if b.NextOffset <= b.FirstOffset {
		return fmt.Errorf("dataeng: batch %q has invalid offset range [%d,%d)", b.ID, b.FirstOffset, b.NextOffset)
	}
	return nil
}

func newBatchID(partition PartitionID, first, next Offset) string {
	return fmt.Sprintf("%d:%d:%d", partition, first, next)
}

// Receipt is returned by a sink after a batch is durably committed.
type Receipt struct {
	Token string    `json:"token,omitempty"`
	At    time.Time `json:"at,omitempty"`
}

// Sink durably commits output batches.
//
// Submit transfers ownership of done to the sink. done must be called exactly
// once, either before Submit returns or later from another goroutine. Submit
// returns nil only when the sink has accepted responsibility for invoking
// done; if Submit returns an error it must not call done.
//
// A sink must be idempotent by [Batch.ID]. In particular, a batch may be
// submitted again after a crash, after a failed offset commit, or by a new
// owner of the partition while a previous owner's commit is still completing.
type Sink interface {
	Submit(ctx context.Context, b Batch, done func(Receipt, error)) error
}

// SinkFunc adapts a synchronous function to [Sink]. The function is invoked
// inline and its result is delivered to done before Submit returns.
type SinkFunc func(ctx context.Context, b Batch) (Receipt, error)

// Submit implements Sink.
func (f SinkFunc) Submit(ctx context.Context, b Batch, done func(Receipt, error)) error {
	receipt, err := f(ctx, b)
	done(receipt, err)
	return nil
}

// Processor turns input records into the output records of a batch.
//
// Processing must be deterministic for a given input range: a recovered or
// re-processed batch is deduplicated by its sink key, so a different output
// for the same key is a correctness bug.
type Processor interface {
	Process(ctx context.Context, records []Record) ([]OutputRecord, error)
}

// ProcessorFunc adapts a function to [Processor].
type ProcessorFunc func(ctx context.Context, records []Record) ([]OutputRecord, error)

// Process implements Processor.
func (f ProcessorFunc) Process(ctx context.Context, records []Record) ([]OutputRecord, error) {
	return f(ctx, records)
}

// IdentityProcessor returns one output record per input record.
func IdentityProcessor(_ context.Context, records []Record) ([]OutputRecord, error) {
	out := make([]OutputRecord, len(records))
	for i, r := range records {
		out[i] = OutputRecord{Key: r.Key, Value: r.Value}
	}
	return out, nil
}

// Reader fetches records from one partition.
//
// Fetch must return records starting exactly at from, in ascending contiguous
// offset order, and at most max records. An empty slice means "no records are
// currently available"; the coordinator will poll again.
type Reader interface {
	Fetch(ctx context.Context, partition PartitionID, from Offset, max int) ([]Record, error)
}

// ReaderFunc adapts a function to [Reader].
type ReaderFunc func(ctx context.Context, partition PartitionID, from Offset, max int) ([]Record, error)

// Fetch implements Reader.
func (f ReaderFunc) Fetch(ctx context.Context, partition PartitionID, from Offset, max int) ([]Record, error) {
	return f(ctx, partition, from, max)
}

// OffsetCommitter commits a next offset to Kafka's consumer-group offset
// store. Commits must be idempotent: committing next twice is harmless, and
// committing an older next must not move the stored offset backwards.
type OffsetCommitter interface {
	CommitOffset(ctx context.Context, partition PartitionID, next Offset) error
}

// OffsetCommitterFunc adapts a function to [OffsetCommitter].
type OffsetCommitterFunc func(ctx context.Context, partition PartitionID, next Offset) error

// CommitOffset implements OffsetCommitter.
func (f OffsetCommitterFunc) CommitOffset(ctx context.Context, partition PartitionID, next Offset) error {
	return f(ctx, partition, next)
}

// EventKind identifies a journal record.
type EventKind string

const (
	// EventBegin is written before a batch is handed to the sink. It contains
	// the batch output so recovery can finish the hand-off without re-running
	// the processor.
	EventBegin EventKind = "begin"
	// EventSinkCommitted proves that the external sink durably accepted the
	// batch.
	EventSinkCommitted EventKind = "sink_committed"
	// EventOffsetCommitted proves that the next offset reached Kafka.
	EventOffsetCommitted EventKind = "offset_committed"
	// EventFenced records that a sink callback arrived after its lease was
	// revoked or superseded. It is informational and never advances a
	// watermark.
	EventFenced EventKind = "fenced"
)

// Event is one append-only transaction-log record.
type Event struct {
	Seq        uint64         `json:"seq"`
	Kind       EventKind      `json:"kind"`
	BatchID    string         `json:"batch_id,omitempty"`
	Partition  PartitionID    `json:"partition"`
	Generation int64          `json:"generation,omitempty"`
	Epoch      uint64         `json:"epoch,omitempty"`
	First      Offset         `json:"first_offset,omitempty"`
	Next       Offset         `json:"next_offset,omitempty"`
	Output     []OutputRecord `json:"output,omitempty"`
	Receipt    Receipt        `json:"receipt,omitempty"`
	Reason     string         `json:"reason,omitempty"`
	At         time.Time      `json:"at"`
}

// Journal is an append-only, crash-recoverable transaction log.
//
// Append must not return until the event is durable. Implementations must be
// safe for concurrent use. [MemoryJournal] is useful for tests, while
// [FileJournal] provides process-crash recovery.
type Journal interface {
	Append(ctx context.Context, event Event) error
	Replay(ctx context.Context) ([]Event, error)
}

// Assignment tells the coordinator that it now owns a partition.
//
// NextOffset is the first offset to fetch, normally the offset stored in
// Kafka's consumer-group metadata. Generation is the consumer-group
// generation supplied by the Kafka client. Assignments are incremental: a
// cooperative rebalance assigns only partitions that were added.
type Assignment struct {
	Partition  PartitionID
	NextOffset Offset
	Generation int64
}

// Lease is the ownership token under which a batch was produced.
type Lease struct {
	Partition  PartitionID
	Generation int64
	Epoch      uint64
}

// Status is a point-in-time view of one partition.
type Status struct {
	Partition  PartitionID
	Generation int64
	Epoch      uint64
	Next       Offset
	Watermark  Offset
	Active     bool
	Revoking   bool
	LastError  error
}

// Lease returns the ownership token described by the status.
func (s Status) Lease() Lease {
	return Lease{Partition: s.Partition, Generation: s.Generation, Epoch: s.Epoch}
}

var (
	// ErrClosed is returned when the coordinator has been closed.
	ErrClosed = errors.New("dataeng: coordinator closed")
	// ErrRevokeTimeout means a revoke could not drain the in-flight sink
	// commit before its deadline. The old lease is fenced immediately.
	ErrRevokeTimeout = errors.New("dataeng: revoke timed out waiting for in-flight commit")
	// ErrStaleLease means a callback belonged to a lease that is no longer the
	// owner of the partition.
	ErrStaleLease = errors.New("dataeng: stale partition lease")
)

// Config configures a [Coordinator].
type Config struct {
	Reader    Reader
	Committer OffsetCommitter
	Sink      Sink
	Processor Processor
	// Journal is the transaction log. If nil, an in-memory journal is used.
	// Coordinator.Close closes the journal when it implements io.Closer.
	Journal Journal

	// BatchSize is the maximum number of input records per batch.
	BatchSize int
	// PollInterval is how long a worker waits after an empty fetch.
	PollInterval time.Duration
	// CommitTimeout bounds a single sink commit plus offset commit.
	CommitTimeout time.Duration
	// RevokeTimeout is used when the caller's context has no deadline.
	RevokeTimeout time.Duration
	// BaseContext is the parent of all partition workers.
	BaseContext context.Context
}

func (c *Config) setDefaults() {
	if c.Processor == nil {
		c.Processor = ProcessorFunc(IdentityProcessor)
	}
	if c.Journal == nil {
		c.Journal = NewMemoryJournal()
	}
	if c.BatchSize <= 0 {
		c.BatchSize = 500
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 50 * time.Millisecond
	}
	if c.CommitTimeout <= 0 {
		c.CommitTimeout = 30 * time.Second
	}
	if c.RevokeTimeout <= 0 {
		c.RevokeTimeout = 30 * time.Second
	}
	if c.BaseContext == nil {
		c.BaseContext = context.Background()
	}
}

func (c Config) validate() error {
	if c.Reader == nil {
		return errors.New("dataeng: Config.Reader is required")
	}
	if c.Committer == nil {
		return errors.New("dataeng: Config.Committer is required")
	}
	if c.Sink == nil {
		return errors.New("dataeng: Config.Sink is required")
	}
	return nil
}
