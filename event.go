package dataeng

import "time"

// Event is one record delivered by the ingestion pipeline.
//
// Timestamp is event time and chooses the window. Value is the additive
// measure aggregated by the processor; Count is tracked independently.
type Event struct {
	Key       string
	Timestamp time.Time
	Value     int64
}
