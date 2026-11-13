// Package dataeng implements a small, dependency-free deduplication engine for
// Prometheus-style samples and exemplars.
//
// A sample is identified by its canonical label set, timestamp and the raw IEEE
// 754 bits of its value. Comparing the bits (instead of using == on float64)
// keeps NaN values well defined and lets the engine distinguish Prometheus
// stale markers from ordinary NaNs.
//
// Replicas are partitioned by external labels. The replica label is removed
// from that partition key, so an HA pair writing the same logical series lands
// in the same state. Each partition carries a leader generation. Samples from
// a generation older than the newest committed generation cannot replace data
// committed by a newer leader.
package dataeng
