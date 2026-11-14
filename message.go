package dataeng

import (
	"fmt"
)

// MessageID identifies one logical Pulsar message.
//
// LedgerID and EntryID identify the broker entry. BatchIndex identifies the
// logical message inside a batched entry. A BatchIndex of -1 denotes a
// non-batched message, matching the Pulsar client convention.
//
// Ordering is lexicographic by LedgerID, EntryID and BatchIndex. A cumulative
// acknowledgement at a coordinate therefore covers every coordinate less than
// or equal to it, including earlier batch indexes in the same entry.
type MessageID struct {
	LedgerID   int64 `json:"ledger_id"`
	EntryID    int64 `json:"entry_id"`
	BatchIndex int32 `json:"batch_index"`
}

// PulsarMessageID is the subset of the pulsar-client-go MessageID interface
// needed by this package. Keeping the dependency structural makes the state
// library importable without pulling in a Pulsar client.
type PulsarMessageID interface {
	LedgerID() int64
	EntryID() int64
	BatchIdx() int32
}

// FromPulsarMessageID converts a Pulsar client message ID into a coordinate.
func FromPulsarMessageID(id PulsarMessageID) MessageID {
	return MessageID{
		LedgerID:   id.LedgerID(),
		EntryID:    id.EntryID(),
		BatchIndex: id.BatchIdx(),
	}
}

// Validate reports whether the message coordinate is well formed.
func (id MessageID) Validate() error {
	if id.LedgerID < 0 || id.EntryID < 0 {
		return fmt.Errorf("%w: ledger=%d entry=%d", ErrInvalidMessageID, id.LedgerID, id.EntryID)
	}
	if id.BatchIndex < -1 {
		return fmt.Errorf("%w: batch index=%d", ErrInvalidMessageID, id.BatchIndex)
	}
	return nil
}

// IsBatched reports whether the message is a member of a batch.
func (id MessageID) IsBatched() bool {
	return id.BatchIndex >= 0
}

// Ledger returns the ledger ID.
func (id MessageID) Ledger() int64 {
	return id.LedgerID
}

// Entry returns the entry ID.
func (id MessageID) Entry() int64 {
	return id.EntryID
}

// BatchIdx returns the batch index.
func (id MessageID) BatchIdx() int32 {
	return id.BatchIndex
}

// NewMessageID constructs a message coordinate.
func NewMessageID(ledgerID, entryID int64, batchIndex int32) MessageID {
	return MessageID{LedgerID: ledgerID, EntryID: entryID, BatchIndex: batchIndex}
}

// Before reports whether id sorts strictly before other.
func (id MessageID) Before(other MessageID) bool {
	return Compare(id, other) < 0
}

// Compare orders two message coordinates. It returns -1, 0 or 1.
func Compare(a, b MessageID) int {
	switch {
	case a.LedgerID < b.LedgerID:
		return -1
	case a.LedgerID > b.LedgerID:
		return 1
	case a.EntryID < b.EntryID:
		return -1
	case a.EntryID > b.EntryID:
		return 1
	case a.BatchIndex < b.BatchIndex:
		return -1
	case a.BatchIndex > b.BatchIndex:
		return 1
	default:
		return 0
	}
}

// CompareMessageIDs is an alias for Compare.
func CompareMessageIDs(a, b MessageID) int {
	return Compare(a, b)
}

func (id MessageID) String() string {
	if id.BatchIndex < 0 {
		return fmt.Sprintf("%d:%d", id.LedgerID, id.EntryID)
	}
	return fmt.Sprintf("%d:%d:%d", id.LedgerID, id.EntryID, id.BatchIndex)
}

// AckType selects the acknowledgement semantics.
type AckType uint8

const (
	// AckIndividual acknowledges exactly one logical message. For a batched
	// entry this leaves the other batch indexes unacknowledged.
	AckIndividual AckType = iota

	// AckCumulative acknowledges every logical message at or before the
	// supplied coordinate, including earlier batch indexes in that entry.
	AckCumulative
)

const (
	AckTypeIndividual = AckIndividual
	AckTypeCumulative = AckCumulative
	IndividualAck     = AckIndividual
	CumulativeAck     = AckCumulative
)

func (a AckType) String() string {
	switch a {
	case AckIndividual:
		return "individual"
	case AckCumulative:
		return "cumulative"
	default:
		return fmt.Sprintf("AckType(%d)", uint8(a))
	}
}

// Disposition tells a consumer what to do when a batch is (re)delivered.
type Disposition uint8

const (
	// NeedsProcessing means no committed output exists for this index. The
	// consumer must process and publish it before acknowledging it.
	NeedsProcessing Disposition = iota

	// NeedsAckOnly means the output was already committed but the broker has
	// not acknowledged this index yet. Publish nothing; send the ack again.
	NeedsAckOnly

	// AlreadyComplete means the index was acknowledged. A redelivery race can
	// still surface it, so it must be ignored.
	AlreadyComplete
)

const (
	DispositionProcess = NeedsProcessing
	DispositionAckOnly = NeedsAckOnly
	DispositionSkip    = AlreadyComplete
	Process            = NeedsProcessing
	AckOnly            = NeedsAckOnly
	Skip               = AlreadyComplete
)

func (d Disposition) String() string {
	switch d {
	case NeedsProcessing:
		return "process"
	case NeedsAckOnly:
		return "ack-only"
	case AlreadyComplete:
		return "skip"
	default:
		return fmt.Sprintf("Disposition(%d)", uint8(d))
	}
}
