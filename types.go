package dataeng

import "errors"

// Sentinel errors returned by the reader. Callers should test with errors.Is.
var (
	// ErrFencedProducer is returned when a batch carries a producer epoch that
	// has been superseded by a newer epoch for the same producer id.
	ErrFencedProducer = errors.New("dataeng: stale producer epoch (producer fenced)")

	// ErrOutOfSequence is returned when a partition receives a record whose
	// producer sequence number jumps forward, indicating lost records or a
	// corrupt log. The reader cannot reconstruct the transaction safely.
	ErrOutOfSequence = errors.New("dataeng: producer sequence number gap")

	// ErrTruncatedTransaction is returned when the log truncates away records
	// belonging to a transaction whose final outcome can no longer be
	// re-established. The reader discards every buffered record of that
	// transaction so a partial transaction can never be delivered.
	ErrTruncatedTransaction = errors.New("dataeng: transaction broken by log truncation")

	// ErrCorruptLog is returned when partition offsets are not contiguous or a
	// control batch cannot be associated with a valid producer/transaction.
	ErrCorruptLog = errors.New("dataeng: corrupt partition log")
)

// ControlType identifies the kind of transaction marker carried by a control
// batch.
type ControlType int

const (
	// ControlCommit marks a transaction as successfully committed.
	ControlCommit ControlType = iota
	// ControlAbort marks a transaction as aborted; all of its data records must
	// be suppressed.
	ControlAbort
)

// Record is one log record. A record is either plain data (ProducerID == 0,
// no transaction) or part of a producer transaction.
type Record struct {
	// Partition and Offset locate the record in its partition log.
	Partition int
	Offset    int64

	// Key and Value carry the application payload.
	Key   []byte
	Value []byte

	// ProducerID identifies the idempotent/transactional producer. It is zero
	// for non-transactional records.
	ProducerID int64
	// ProducerEpoch is the epoch of the producer when the record was written.
	ProducerEpoch int16
	// Sequence is the per-partition producer sequence number.
	Sequence int32

	// Transactional is true for records written inside a transaction.
	Transactional bool
}

// Batch is a contiguous set of records fetched from one partition.
//
// A data batch carries one or more records. A control batch carries no data
// records; its marker finalizes the transaction identified by ProducerID and
// ProducerEpoch.
type Batch struct {
	Partition int
	// BaseOffset is the offset of the first record (or marker) in the batch.
	BaseOffset int64
	// LeaderEpoch is the broker leader epoch that wrote the batch. It is used to
	// detect stale leaders after truncation.
	LeaderEpoch int32

	// ProducerID and ProducerEpoch identify the producer that wrote the batch.
	ProducerID    int64
	ProducerEpoch int16

	// Records are the data records. Empty for a control batch.
	Records []*Record

	// Control is true when this is a control batch.
	Control bool
	// Marker is the transaction outcome; meaningful only when Control is true.
	Marker ControlType
}

// FetchResponse is the result of one partition fetch.
type FetchResponse struct {
	Partition int
	// Batches are returned in ascending offset order and must be offset
	// contiguous with respect to any previously consumed batches.
	Batches []*Batch

	// LastStableOffset bounds the offsets that are safe to deliver under
	// read-committed semantics. Transactional records at offsets >= LSO belong
	// to transactions whose outcome is not yet known and stay buffered.
	// A value <= 0 disables LSO withholding (the reader then relies solely on
	// commit/abort markers).
	LastStableOffset int64
}
