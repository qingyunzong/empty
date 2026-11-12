// Package dataeng provides a telemetry correlation component that joins
// observations with per-device configuration validity intervals under
// event-time watermarks.
//
// Observations carry a device ID, an integer event time and a globally unique
// ID. Configuration intervals are half-open [Start, End) windows that never
// overlap for a device, cannot be revised or deleted, and may arrive out of
// order. Two monotonically increasing watermarks — one for configuration
// interval starts and one for observation event times, initially negative
// infinity — bound how late input may arrive.
//
// An observation is emitted, together with the unique interval covering it
// (or as unmatched), only once both watermarks are strictly greater than its
// event time. Emission order is ascending event time, with ties broken by the
// UTF-8 byte order of the observation ID. Re-delivery of an observation or an
// interval with identical content is ignored; conflicting re-delivery,
// overlapping intervals and watermark violations are rejected without
// changing component state.
//
// The output callback is idempotent per observation ID. Only an explicit
// callback success removes the observation; failure or an unknown outcome
// stops emission and the same ID can be retried via Correlator.Flush. The
// caller is responsible for deduplicating external side effects.
package dataeng
