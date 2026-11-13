package dataeng

import "bytes"

// Record is a source record from an ingestion partition.
type Record struct {
	Partition int
	Offset    int64
	Payload   []byte
}

// DeadLetter is a failed record with its source coordinates intact.
//
// Reason and Reasons are the canonical reason fields. Reason always holds the
// first reason observed for the coordinate; Reasons contains that first reason
// followed by every later reason in encounter order. ReasonCode and ReasonCodes
// mirror those fields for callers that model dead-letter metadata as reason
// codes.
type DeadLetter struct {
	Partition int
	Offset    int64
	Payload   []byte

	Reason      string
	Reasons     []string
	ReasonCode  string
	ReasonCodes []string
}

// FirstReason returns the reason from the first failure for the coordinate.
func (d DeadLetter) FirstReason() string {
	if d.Reason != "" {
		return d.Reason
	}
	return d.ReasonCode
}

// AllReasons returns the first reason followed by all later reasons.
func (d DeadLetter) AllReasons() []string {
	if len(d.Reasons) != 0 {
		return append([]string(nil), d.Reasons...)
	}
	if len(d.ReasonCodes) != 0 {
		return append([]string(nil), d.ReasonCodes...)
	}
	if first := d.FirstReason(); first != "" {
		return []string{first}
	}
	return nil
}

// Coordinates returns the original partition and offset.
func (d DeadLetter) Coordinates() (partition int, offset int64) {
	return d.Partition, d.Offset
}

// Equal compares the semantic dead-letter contents while allowing callers to
// use either the Reason or ReasonCode view of the reason metadata.
func (d DeadLetter) Equal(other DeadLetter) bool {
	if d.Partition != other.Partition || d.Offset != other.Offset {
		return false
	}
	if !bytes.Equal(d.Payload, other.Payload) {
		return false
	}

	reasons := d.AllReasons()
	otherReasons := other.AllReasons()
	if len(reasons) != len(otherReasons) {
		return false
	}
	for i := range reasons {
		if reasons[i] != otherReasons[i] {
			return false
		}
	}
	return true
}

func clonePayload(payload []byte) []byte {
	if payload == nil {
		return nil
	}
	cloned := make([]byte, len(payload))
	copy(cloned, payload)
	return cloned
}

func newDeadLetter(record Record, reason string) DeadLetter {
	reasons := []string{reason}
	return DeadLetter{
		Partition:   record.Partition,
		Offset:      record.Offset,
		Payload:     clonePayload(record.Payload),
		Reason:      reason,
		Reasons:     reasons,
		ReasonCode:  reason,
		ReasonCodes: append([]string(nil), reasons...),
	}
}
