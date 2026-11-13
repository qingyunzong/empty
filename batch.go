package dataeng

import "fmt"

// RawRecord is a Kinesis record as returned by GetRecords before
// deaggregation.
type RawRecord struct {
	SequenceNumber string
	Data           []byte
}

// AggregateRecord is an alias for RawRecord.
type AggregateRecord = RawRecord

// BatchResult is the result of fully successful batch deaggregation.
type BatchResult struct {
	Records    []Record
	Checkpoint Checkpoint
}

// DeaggregateBatch deaggregates a batch as one atomic unit.
//
// If any parent record is invalid, the function returns no user records and a
// zero checkpoint. This prevents a caller from acknowledging the healthy
// parents while silently losing the children of a corrupt aggregate.
func DeaggregateBatch(batch []RawRecord) ([]Record, Checkpoint, error) {
	result, err := ProcessBatch(batch)
	if err != nil {
		return nil, Checkpoint{}, err
	}
	return result.Records, result.Checkpoint, nil
}

// ProcessBatch is the structured form of DeaggregateBatch.
func ProcessBatch(batch []RawRecord) (BatchResult, error) {
	result := BatchResult{
		Records: make([]Record, 0),
	}

	for i, raw := range batch {
		records, err := Deaggregate(raw.Data, raw.SequenceNumber)
		if err != nil {
			return BatchResult{}, fmt.Errorf("dataeng: batch record %d (sequence %q): %w",
				i, raw.SequenceNumber, err)
		}
		for _, record := range records {
			result.Records = append(result.Records, record)
			result.Checkpoint = record.Checkpoint()
		}
	}

	return result, nil
}

// DeaggregateBatchRecords is an alias for DeaggregateBatch that returns only
// user records. It preserves the same all-or-nothing semantics.
func DeaggregateBatchRecords(batch []RawRecord) ([]Record, error) {
	records, _, err := DeaggregateBatch(batch)
	return records, err
}

// DeaggregateRecords is an alias for DeaggregateBatchRecords.
func DeaggregateRecords(batch []RawRecord) ([]Record, error) {
	return DeaggregateBatchRecords(batch)
}
