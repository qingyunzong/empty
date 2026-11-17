// Package formal implements a stateful SLO burn-rate window evaluator.
//
// SLI data is supplied as fixed-width, interval-count buckets. Buckets may
// arrive out of order and may be replaced later (backfill or correction).
// The evaluator derives a short and a long burn-rate window over completed
// buckets, suppresses transitions while either window lacks sufficient data,
// and fires only when both windows are above the fire threshold. Recovery
// uses a lower threshold (hysteresis) and an optional dwell time.
package formal
