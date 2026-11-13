// Package dataeng provides an importable quota scheduler for multi-tenant
// collectors. It models a provider's global, per-app, per-user and
// per-endpoint limits as one hierarchy of token buckets, so a single
// Acquire reserves quota at every level atomically.
//
// Pending requests are scanned in arrival order and earlier waiters
// reserve their share of any bucket they are waiting on, so tokens are
// never over-issued and no tenant can be starved by the others. A 429
// response freezes only the bucket that was hit (Scheduler.Throttle), with
// Retry-After accepted as seconds or an HTTP date and server clock skew
// corrected from the response Date header. Cancelling a task returns its
// unconsumed reservation to every bucket it drew from
// (Reservation.Cancel). Time is injectable through the Clock interface,
// so tests can drive scheduling deterministically with ManualClock.
package dataeng
