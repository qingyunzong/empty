package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrShardNotFound is returned when an operation names a shard that is
	// absent from the observed reshard graph.
	ErrShardNotFound = errors.New("dataeng: shard not found")
	// ErrShardConflict reports inconsistent duplicate shard metadata.
	ErrShardConflict = errors.New("dataeng: conflicting shard metadata")
	// ErrShardCycle reports a cycle in parent/adjacent-parent links.
	ErrShardCycle = errors.New("dataeng: shard dependency cycle")

	// ErrShardNotReady is matched by MissingParentsError and
	// PendingParentsError. It lets a scheduler use one check for either
	// condition.
	ErrShardNotReady = errors.New("dataeng: shard not ready")
	// ErrMissingParent reports a child that references a parent not present in
	// the reshard graph. The coordinator waits instead of guessing.
	ErrMissingParent = errors.New("dataeng: shard has a missing parent")
	// ErrParentsNotComplete reports known parents that have not completed.
	ErrParentsNotComplete = errors.New("dataeng: parent shards are not complete")
	// ErrShardCompleted reports an operation on a shard that already completed.
	ErrShardCompleted = errors.New("dataeng: shard already completed")

	// ErrLeaseHeld reports an active lease owned by another worker.
	ErrLeaseHeld = errors.New("dataeng: shard lease is held by another worker")
	// ErrLeaseLost reports a lease token whose owner or generation is stale.
	ErrLeaseLost = errors.New("dataeng: lease generation is stale")
	// ErrLeaseExpired reports an expired lease. The holder must reacquire, which
	// issues a new generation.
	ErrLeaseExpired = errors.New("dataeng: lease has expired")
	// ErrInvalidLease reports a malformed or incomplete lease token.
	ErrInvalidLease = errors.New("dataeng: invalid lease")
	// ErrEmptyWorkerID reports a lease acquisition without a worker identity.
	ErrEmptyWorkerID = errors.New("dataeng: worker id is empty")
	// ErrInvalidLeaseTTL reports a non-positive lease duration.
	ErrInvalidLeaseTTL = errors.New("dataeng: lease ttl must be positive")

	// ErrInvalidWatermark reports an empty watermark.
	ErrInvalidWatermark = errors.New("dataeng: watermark is empty")
	// ErrInvalidOutputAck reports an empty output acknowledgement.
	ErrInvalidOutputAck = errors.New("dataeng: output acknowledgement is empty")
	// ErrAckAheadOfWatermark reports an acknowledgement beyond processed input.
	ErrAckAheadOfWatermark = errors.New("dataeng: output acknowledgement is ahead of watermark")
	// ErrProgressRegression reports a watermark or acknowledgement moving
	// backwards.
	ErrProgressRegression = errors.New("dataeng: shard progress moved backwards")
	// ErrShardNotClosed reports a completion attempt for an open shard.
	ErrShardNotClosed = errors.New("dataeng: shard is not closed")
	// ErrIncompleteClose reports a close attempt whose watermark or output
	// acknowledgement has not reached the closed shard's end.
	ErrIncompleteClose = errors.New("dataeng: closed shard is not fully acknowledged")

	// ErrVersionConflict is returned by Store.CompareAndSwap when the record
	// changed after it was loaded. The coordinator retries automatically.
	ErrVersionConflict = errors.New("dataeng: record version conflict")
)

// ShardConflictError describes two observations that cannot describe the same
// shard.
type ShardConflictError struct {
	ShardID  ShardID
	Field    string
	Existing string
	Observed string
}

func (e *ShardConflictError) Error() string {
	return fmt.Sprintf("dataeng: shard %q conflicts on %s: existing %q, observed %q",
		e.ShardID, e.Field, e.Existing, e.Observed)
}

func (e *ShardConflictError) Unwrap() error { return ErrShardConflict }

// CycleError describes a dependency cycle. Path repeats the first node at the
// end so it can be rendered directly.
type CycleError struct {
	Path []ShardID
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("dataeng: shard dependency cycle: %v", e.Path)
}

func (e *CycleError) Unwrap() error { return ErrShardCycle }

// MissingParentsError is returned when a child references one or more parents
// absent from the reshard graph. Waiting is deliberate: an absent parent may
// still appear in a later DescribeStream page.
type MissingParentsError struct {
	ShardID ShardID
	Parents []ShardID
}

func (e *MissingParentsError) Error() string {
	return fmt.Sprintf("dataeng: shard %q is waiting for missing parent shards %v",
		e.ShardID, e.Parents)
}

// Unwrap exposes both sentinels so callers can test for missing-parent detail
// or the broader not-ready condition.
func (e *MissingParentsError) Unwrap() []error {
	return []error{ErrMissingParent, ErrShardNotReady}
}

// PendingParentsError is returned when known parents have not completed.
type PendingParentsError struct {
	ShardID ShardID
	Parents []ShardID
}

func (e *PendingParentsError) Error() string {
	return fmt.Sprintf("dataeng: shard %q is waiting for parent shards %v to complete",
		e.ShardID, e.Parents)
}

func (e *PendingParentsError) Unwrap() []error {
	return []error{ErrParentsNotComplete, ErrShardNotReady}
}

// LeaseHeldError includes the active lease so a scheduler can make an informed
// decision about retrying later.
type LeaseHeldError struct {
	ShardID ShardID
	Lease   Lease
}

func (e *LeaseHeldError) Error() string {
	return fmt.Sprintf("dataeng: shard %q lease is held by %q until %s",
		e.ShardID, e.Lease.Owner, e.Lease.ExpiresAt.Format(timeFormat))
}

func (e *LeaseHeldError) Unwrap() error { return ErrLeaseHeld }

// IncompleteCloseError describes why a final commit was rejected.
type IncompleteCloseError struct {
	ShardID     ShardID
	Ending      SequenceNumber
	Watermark   SequenceNumber
	OutputAck   SequenceNumber
	ShardClosed bool
}

func (e *IncompleteCloseError) Error() string {
	return fmt.Sprintf(
		"dataeng: shard %q cannot complete (closed=%t, ending=%q, watermark=%q, output ack=%q)",
		e.ShardID, e.ShardClosed, e.Ending, e.Watermark, e.OutputAck)
}

func (e *IncompleteCloseError) Unwrap() error { return ErrIncompleteClose }

const timeFormat = "2006-01-02T15:04:05.999999999Z07:00"
