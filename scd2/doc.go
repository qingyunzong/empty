// Package scd2 implements a slowly-changing-dimension type 2 interval
// component for dimension loaders.
//
// Intervals are keyed by business key and carry the source effective time
// as half-open ranges [From, To). A zero To means the interval is
// open-ended and represents the current row; at most one such interval
// exists per business key. Late-arriving changes split existing intervals,
// and adjacent intervals with identical attributes are merged
// automatically. Every mutation returns the minimal changeset (adds,
// updates, removes) needed to persist the new state, and AsOf point-in-time
// queries allow the result to be verified.
package scd2
