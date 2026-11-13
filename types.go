package dataeng

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"
)

// Record is an application record delivered by an export stream.
//
// ID identifies the logical record. Version is a server-assigned,
// monotonically increasing revision for that record within a snapshot. The
// connector uses Version to discard records resent at a resume boundary.
type Record struct {
	ID      string
	Version uint64
	Data    []byte
}

// Batch is one server-streamed export message.
//
// SnapshotID and Generation bind the message to a snapshot and to the
// connection that requested it. ResumeToken confirms every record in the
// batch and is the only position the connector may resume from after the
// batch has been acknowledged.
type Batch struct {
	SnapshotID  string
	Generation  uint64
	Records     []Record
	ResumeToken string
}

// OpenRequest is passed to a StreamOpener for every connection attempt.
//
// ResumeToken is always the token of the last acknowledged batch. It is never
// copied from an unacknowledged message.
type OpenRequest struct {
	SnapshotID  string
	ResumeToken string
	Generation  uint64
}

// Stream is the server-streaming part of a gRPC export call.
//
// Recv returns io.EOF after the server has finished the snapshot. The opener
// should map a grpc status indicating an expired resume token to
// ErrResumeTokenInvalid.
type Stream interface {
	Recv() (Batch, error)
	Close() error
}

// Ack is sent back to a server that requires explicit batch acknowledgements.
type Ack struct {
	SnapshotID  string
	ResumeToken string
	Generation  uint64
}

// AckStream is implemented by streams that require an acknowledgement after a
// batch has been applied and its token has been made durable.
type AckStream interface {
	Ack(ctx context.Context, ack Ack) error
}

// StreamOpener opens a stream at req's snapshot and resume position.
type StreamOpener interface {
	Open(ctx context.Context, req OpenRequest) (Stream, error)
}

// Snapshot is the identity and initial position of a newly created export
// snapshot.
type Snapshot struct {
	ID          string
	ResumeToken string
}

// SnapshotStarter creates a fresh snapshot when the server rejects a resume
// token. previousSnapshotID is the snapshot whose token was rejected.
type SnapshotStarter interface {
	StartSnapshot(ctx context.Context, previousSnapshotID string) (Snapshot, error)
}

// Checkpoint is the durable recovery position.
//
// Generation increments for every connection attempt. ResumeToken changes only
// after a batch has been confirmed by Sink and persisted. Complete prevents a
// finished snapshot from being streamed again. PendingReconcile records the
// snapshot that a completed replacement still has to be reconciled against.
type Checkpoint struct {
	SnapshotID       string
	ResumeToken      string
	Generation       uint64
	Complete         bool
	PendingReconcile string
}

// CheckpointStore durably stores the connector checkpoint.
//
// Save must be atomic: a crash must leave either the previous checkpoint or
// the new one, never a mix of the two. A single Connector owns the store.
type CheckpointStore interface {
	Load(ctx context.Context) (Checkpoint, error)
	Save(ctx context.Context, checkpoint Checkpoint) error
}

// DeliveredBatch is a confirmed-able batch passed to a Sink. Records contains
// only records that were not already delivered at an equal or higher version.
//
// Replacement is true when the batch belongs to a new snapshot created because
// the previous token became invalid. A sink that stages replacement snapshots
// must keep them separate from the snapshot named by Replaces until Reconcile
// is called.
type DeliveredBatch struct {
	SnapshotID  string
	Generation  uint64
	ResumeToken string
	Records     []Record
	Replacement bool
	Replaces    string
}

// RecordRef identifies a version of a record without carrying its payload.
type RecordRef struct {
	ID      string
	Version uint64
	Digest  [sha256.Size]byte
}

// RecordChange describes a record whose version or content changed between
// snapshots.
type RecordChange struct {
	Before RecordRef
	After  RecordRef
}

// Reconciliation is the explicit comparison between the last known snapshot
// and a replacement snapshot. The connector never appends a replacement
// snapshot to the old result without producing this value.
type Reconciliation struct {
	PreviousSnapshotID string
	SnapshotID         string
	Added              []RecordRef
	Removed            []RecordRef
	Changed            []RecordChange
	Unchanged          int
}

// Sink receives batches and replacement reconciliations.
//
// ApplyBatch returning nil confirms the batch. The connector then persists the
// batch's resume token and, for an AckStream, sends the wire acknowledgement.
// A non-nil error stops the stream and leaves the previous checkpoint intact.
//
// Reconcile is called exactly once for a completed replacement snapshot,
// before the connector reports success. Implementations should replace the old
// snapshot's results atomically rather than concatenating the two result sets.
type Sink interface {
	ApplyBatch(ctx context.Context, batch DeliveredBatch) error
	Reconcile(ctx context.Context, reconciliation Reconciliation) error
}

// SnapshotReason describes why a snapshot stream was opened.
type SnapshotReason string

const (
	// SnapshotInitial is a newly created first snapshot.
	SnapshotInitial SnapshotReason = "initial"
	// SnapshotResume resumes an existing snapshot from a durable checkpoint.
	SnapshotResume SnapshotReason = "resume"
	// SnapshotReplacement replaces a snapshot whose resume token was rejected.
	SnapshotReplacement SnapshotReason = "replacement"
)

// SnapshotEvent is an optional snapshot lifecycle notification.
type SnapshotEvent struct {
	SnapshotID  string
	ResumeToken string
	Generation  uint64
	Reason      SnapshotReason
	Replaces    string
}

// SnapshotLifecycle may be implemented by a Sink to observe snapshot
// boundaries. BeginSnapshot should stage a replacement snapshot separately
// from Replaces until Reconcile is called.
type SnapshotLifecycle interface {
	BeginSnapshot(ctx context.Context, event SnapshotEvent) error
	EndSnapshot(ctx context.Context, event SnapshotEvent) error
}

// SnapshotAbandoner may be implemented by a Sink to discard a partially
// delivered replacement snapshot that was itself invalidated. The connector
// never reconciles a partial replacement against the previous snapshot.
type SnapshotAbandoner interface {
	AbandonSnapshot(ctx context.Context, event SnapshotEvent) error
}

// RetryPolicy controls reconnects after transport failures.
type RetryPolicy struct {
	// MaxAttempts is the maximum number of consecutive failed connection
	// attempts. Zero means retry until the context is cancelled.
	MaxAttempts int
	// InitialBackoff is the delay before the first reconnect. Zero disables
	// waiting.
	InitialBackoff time.Duration
	// MaxBackoff caps exponential backoff. Zero leaves the delay uncapped.
	MaxBackoff time.Duration
}

// DefaultRetryPolicy reconnects until the context is cancelled, with a short
// exponential backoff.
func DefaultRetryPolicy() RetryPolicy {
	return RetryPolicy{
		InitialBackoff: 100 * time.Millisecond,
		MaxBackoff:     5 * time.Second,
	}
}

// Stats is a point-in-time view of connector activity.
type Stats struct {
	Connections      uint64
	StaleBatches     uint64
	DuplicateRecords uint64
	SnapshotRestarts uint64
}

// Config configures a Connector.
type Config struct {
	Opener    StreamOpener
	Snapshots SnapshotStarter
	Store     CheckpointStore
	Sink      Sink
	Retry     RetryPolicy
}

func (r Record) validate() error {
	if r.ID == "" {
		return fmt.Errorf("record id is empty")
	}
	return nil
}
