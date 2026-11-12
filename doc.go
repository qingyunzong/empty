// Package dataeng implements an embedded differential-dataflow host whose
// logical times are two-dimensional (outer batch, inner iteration) in the
// componentwise product order. It deliberately does not use a lexicographic
// watermark: (0,1) and (1,0) are incomparable, and a query completes only when
// no input frontier point is at or before it.
//
// A Host tracks one finite antichain frontier per input, a global since
// antichain, arbitrary-precision signed weights keyed by (key,time), and live
// query registrations. All mutating operations are atomic: validation failures
// leave the complete host state unchanged. Frontend display order is (x,y), but
// it is never used for ordering decisions. Host implements json.Marshaler and
// json.Unmarshaler; RestoreSnapshot/RestoreHost validate invariants on restore.
package dataeng
