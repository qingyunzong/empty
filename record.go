package dataeng

// Record is a single user record recovered from a Kinesis Producer Library
// (KPL) aggregated record.
//
// All records recovered from one aggregate share the parent Kinesis sequence
// number. SubSequenceNumber is the zero-based position of the record inside
// that aggregate, which makes it possible to checkpoint individual user
// records rather than the whole parent record.
type Record struct {
	Data              []byte
	PartitionKey      string
	ExplicitHashKey   string
	SequenceNumber    string
	SubSequenceNumber int
}

// UserRecord is an alias for Record, matching the terminology used by the
// Kinesis Client Library.
type UserRecord = Record

// DeaggregatedRecord is an alias for Record.
type DeaggregatedRecord = Record

// HasExplicitHashKey reports whether the KPL record carried an explicit hash
// key. An empty string means the parent record did not specify one.
func (r Record) HasExplicitHashKey() bool {
	return r.ExplicitHashKey != ""
}

// ParentSequenceNumber returns the sequence number of the Kinesis record that
// contained this user record.
func (r Record) ParentSequenceNumber() string {
	return r.SequenceNumber
}

// SubSequence returns the zero-based position inside the parent aggregate.
func (r Record) SubSequence() int {
	return r.SubSequenceNumber
}

// Checkpoint returns a checkpoint positioned at this record.
func (r Record) Checkpoint() Checkpoint {
	return Checkpoint{
		SequenceNumber:    r.SequenceNumber,
		SubSequenceNumber: r.SubSequenceNumber,
	}
}
