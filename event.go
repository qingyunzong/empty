package dataeng

import "math"

// NoWatermark is reported when a partition has no usable watermark yet. It is
// also used as the Watermark field of outputs produced before a partition has
// an active, known source.
const NoWatermark int64 = math.MinInt64

// Event is an input record. Partition and Key scope window state; Source
// identifies the logical input that produced the record. Timestamp is event
// time in caller-defined units (milliseconds are typical). Value is opaque to
// the window operator; it is retained in revisions and handed to the optional
// aggregate function.
type Event struct {
	Partition string
	Source    string
	Key       string
	Timestamp int64
	Value     any
}

// Heartbeat advances one source's event-time watermark. When Idle is true the
// source explicitly leaves the active set, so it no longer constrains the
// partition watermark. A later non-idle heartbeat reactivates the source.
//
// Source watermarks are monotonic: a lower Timestamp never moves a source
// backwards. A new or reactivated source is fast-forwarded to the partition's
// current watermark so that partition watermarks cannot regress.
type Heartbeat struct {
	Partition string
	Source    string
	Timestamp int64
	Idle      bool
}

// SourceInfo is a point-in-time view of one source's watermark state.
type SourceInfo struct {
	ID           string
	Watermark    int64
	HasWatermark bool
	Idle         bool
}
