// Package dataeng provides an embeddable event-time window operator for Go
// stream processors.
//
// It supports tumbling, sliding, and session windows; per-partition
// watermarks computed from the minimum of active sources; explicit idle
// heartbeats; versioned late revisions with a side output after the allowed
// lateness deadline; and deterministic snapshot recovery of trigger order and
// window versions.
package dataeng
