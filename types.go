package formal

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

// TxnID identifies one sink transaction. Reusing an identifier is how a sink
// operator retries an operation after an uncertain result; the coordinator
// returns the original durable receipt for a committed transaction.
type TxnID string

// Record is one output record produced by a sink operator. ID is an optional
// application-level identifier. When non-empty it must be unique within a
// transaction and across all committed transactions, which gives the sink a
// stable deduplication key in addition to TxnID.
type Record struct {
	ID   string
	Data []byte
}

// Clone returns a deep copy of the record.
func (r Record) Clone() Record {
	return Record{ID: r.ID, Data: cloneBytes(r.Data)}
}

// TxnState is the durable state of a transaction.
type TxnState uint8

const (
	// TxnAbsent means that no durable record for the transaction exists.
	TxnAbsent TxnState = iota
	// TxnOpen means that Begin was accepted but Prepare is not durable.
	TxnOpen
	// TxnPrepared means the records are durable but the commit point is not.
	// Prepared data is in flight and is never exposed as committed.
	TxnPrepared
	// TxnCommitted means the commit record is durable.
	TxnCommitted
	// TxnAborted means the transaction is durably aborted.
	TxnAborted
)

// Aliases kept short for callers that prefer StateOpen-style names.
const (
	StateAbsent    = TxnAbsent
	StateOpen      = TxnOpen
	StatePrepared  = TxnPrepared
	StateCommitted = TxnCommitted
	StateAborted   = TxnAborted
)

// String returns the stable lowercase state name.
func (s TxnState) String() string {
	switch s {
	case TxnAbsent:
		return "absent"
	case TxnOpen:
		return "open"
	case TxnPrepared:
		return "prepared"
	case TxnCommitted:
		return "committed"
	case TxnAborted:
		return "aborted"
	default:
		return fmt.Sprintf("txn-state(%d)", uint8(s))
	}
}

// Receipt is the stable result of a transaction. Repeating Prepare before
// commit, Commit after commit, or Abort after abort, including after a
// restart, returns the same values stored in the commit log.
type Receipt struct {
	TxnID       TxnID
	State       TxnState
	PrepareSeq  uint64
	CommitSeq   uint64
	AbortSeq    uint64
	RecordCount int
	Digest      [sha256.Size]byte
}

// Committed reports whether the transaction has crossed the durable commit
// point.
func (r Receipt) Committed() bool { return r.State == TxnCommitted }

// TxnView is an immutable snapshot of one transaction.
type TxnView struct {
	TxnID      TxnID
	State      TxnState
	PrepareSeq uint64
	CommitSeq  uint64
	AbortSeq   uint64
	Digest     [sha256.Size]byte
	Records    []Record
	Applied    bool
}

// OutputRecord is one committed record, annotated with its transaction.
type OutputRecord struct {
	TxnID     TxnID
	CommitSeq uint64
	Record    Record
}

// Delivery is handed to a Sink exactly in commit order. Apply must be
// idempotent for (TxnID, CommitSeq): recovery can re-deliver a committed
// transaction if the process died after the external effect but before the
// acknowledgement record became durable.
type Delivery struct {
	TxnID     TxnID
	CommitSeq uint64
	Digest    [sha256.Size]byte
	Records   []Record
}

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	return append([]byte(nil), b...)
}

func cloneRecords(records []Record) []Record {
	if records == nil {
		return nil
	}
	out := make([]Record, len(records))
	for i, record := range records {
		out[i] = record.Clone()
	}
	return out
}

func recordsDigest(id TxnID, records []Record) [sha256.Size]byte {
	h := sha256.New()
	var buf [binary.MaxVarintLen64]byte

	writeBytes := func(b []byte) {
		n := binary.PutUvarint(buf[:], uint64(len(b)))
		_, _ = h.Write(buf[:n])
		_, _ = h.Write(b)
	}

	writeBytes([]byte(id))
	for _, record := range records {
		writeBytes([]byte(record.ID))
		writeBytes(record.Data)
	}

	var digest [sha256.Size]byte
	copy(digest[:], h.Sum(nil))
	return digest
}

func validateRecords(records []Record) error {
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if record.ID == "" {
			continue
		}
		if _, ok := seen[record.ID]; ok {
			return fmt.Errorf("%w: %q", ErrDuplicateRecord, record.ID)
		}
		seen[record.ID] = struct{}{}
	}
	return nil
}

func equalRecords(a, b []Record) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID || !bytes.Equal(a[i].Data, b[i].Data) {
			return false
		}
	}
	return true
}
