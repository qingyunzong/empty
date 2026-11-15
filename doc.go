// Package dataeng provides weighted, multi-tenant quota scheduling for
// external API collectors.
//
// A Scheduler combines a global token bucket, one bucket per tenant, and one
// bucket per endpoint. A request is admitted only when all three have enough
// tokens. Tenant weights provide long-term fair sharing, while Retry-After
// responses and server quota headers update the same state without allowing
// over-allocation.
//
// Reservations settle exactly once through Commit, Fail, or Cancel. Use
// ManualClock in tests to drive all scheduling with virtual time.
package dataeng
