package dataeng

import "fmt"

// BatchID addresses a contiguous Pulsar batch whose indexes are
// [0, Count). Indexes are int32 in the Pulsar protocol.
type BatchID struct {
	LedgerID int64 `json:"ledger_id"`
	EntryID  int64 `json:"entry_id"`
	Count    int   `json:"count"`
}

// Batch is an alias for BatchID.
type Batch = BatchID

// Validate reports whether the batch description is well formed.
func (b BatchID) Validate() error {
	if b.LedgerID < 0 || b.EntryID < 0 {
		return fmt.Errorf("%w: ledger=%d entry=%d", ErrInvalidMessageID, b.LedgerID, b.EntryID)
	}
	if b.Count < 0 {
		return fmt.Errorf("%w: negative batch count %d", ErrInvalidMessageID, b.Count)
	}
	return nil
}

// Message returns the coordinate of a batch index.
func (b BatchID) Message(index int32) MessageID {
	return MessageID{LedgerID: b.LedgerID, EntryID: b.EntryID, BatchIndex: index}
}

// Indexes returns the indexes in the batch in ascending order.
func (b BatchID) Indexes() []int32 {
	if b.Count <= 0 {
		return nil
	}
	out := make([]int32, b.Count)
	for i := range out {
		out[i] = int32(i)
	}
	return out
}

// BatchStatus is the result of scanning a re-delivered batch. All index slices
// are ascending. Unacknowledged is the union of ToPublish and ToAck.
type BatchStatus struct {
	LedgerID       int64   `json:"ledger_id"`
	EntryID        int64   `json:"entry_id"`
	Count          int     `json:"count"`
	Unacknowledged []int32 `json:"unacknowledged,omitempty"`
	ToPublish      []int32 `json:"to_publish,omitempty"`
	ToAck          []int32 `json:"to_ack,omitempty"`
	Acknowledged   []int32 `json:"acknowledged,omitempty"`
	Err            error   `json:"-"`
}

// Pending returns the indexes that still need an acknowledgement.
func (s BatchStatus) Pending() []int32 {
	return append([]int32(nil), s.Unacknowledged...)
}

// Complete reports whether every index is acknowledged.
func (s BatchStatus) Complete() bool {
	return s.Err == nil && len(s.Unacknowledged) == 0
}
