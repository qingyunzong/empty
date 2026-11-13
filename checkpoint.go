package dataeng

import (
	"math/big"
	"strings"
)

// Checkpoint identifies the last processed user record. Kinesis sequence
// numbers are shared by every record in an aggregate, so SubSequenceNumber is
// required to resume at the exact child record.
//
// A zero Checkpoint means that no record has been acknowledged.
type Checkpoint struct {
	SequenceNumber    string
	SubSequenceNumber int
}

// ReplayCheckpoint is an alias for Checkpoint.
type ReplayCheckpoint = Checkpoint

// NewCheckpoint constructs a checkpoint for the given parent sequence number
// and zero-based child position.
func NewCheckpoint(sequenceNumber string, subSequenceNumber int) Checkpoint {
	return Checkpoint{
		SequenceNumber:    sequenceNumber,
		SubSequenceNumber: subSequenceNumber,
	}
}

// IsZero reports whether the checkpoint has not acknowledged any record.
func (c Checkpoint) IsZero() bool {
	return c.SequenceNumber == "" && c.SubSequenceNumber == 0
}

// Covers reports whether record has already been processed at checkpoint c.
func (c Checkpoint) Covers(record Record) bool {
	order := compareSequenceNumbers(record.SequenceNumber, c.SequenceNumber)
	if order < 0 {
		return true
	}
	if order > 0 {
		return false
	}
	return record.SubSequenceNumber <= c.SubSequenceNumber
}

// Advance returns a checkpoint that covers record and everything before it.
// It never moves a checkpoint backwards.
func (c Checkpoint) Advance(record Record) Checkpoint {
	if c.Covers(record) {
		return c
	}
	return record.Checkpoint()
}

// NextSubSequence returns a checkpoint that resumes after c's current child.
func (c Checkpoint) NextSubSequence() Checkpoint {
	c.SubSequenceNumber++
	return c
}

// AfterCheckpoint removes records that were already acknowledged by c. Records
// are filtered by both parent sequence number and child position.
func AfterCheckpoint(records []Record, checkpoint Checkpoint) []Record {
	if checkpoint.IsZero() {
		return records
	}
	remaining := make([]Record, 0, len(records))
	for _, record := range records {
		if !checkpoint.Covers(record) {
			remaining = append(remaining, record)
		}
	}
	return remaining
}

// DeaggregateFromCheckpoint deaggregates data and drops children that are at
// or before checkpoint. The parent sequence number identifies the aggregate
// being replayed.
func DeaggregateFromCheckpoint(data []byte, parentSequenceNumber string, checkpoint Checkpoint) ([]Record, error) {
	records, err := Deaggregate(data, parentSequenceNumber)
	if err != nil {
		return nil, err
	}
	return AfterCheckpoint(records, checkpoint), nil
}

// ReplayAfterCheckpoint is an alias for DeaggregateFromCheckpoint.
func ReplayAfterCheckpoint(data []byte, parentSequenceNumber string, checkpoint Checkpoint) ([]Record, error) {
	return DeaggregateFromCheckpoint(data, parentSequenceNumber, checkpoint)
}

func compareSequenceNumbers(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return -1
	}
	if b == "" {
		return 1
	}

	ai, aOK := new(big.Int).SetString(strings.TrimSpace(a), 10)
	bi, bOK := new(big.Int).SetString(strings.TrimSpace(b), 10)
	if aOK && bOK {
		return ai.Cmp(bi)
	}
	return strings.Compare(a, b)
}
