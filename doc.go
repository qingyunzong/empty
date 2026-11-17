// Package formal implements a lease-based leader election state machine for
// controllers that span multiple clusters.
//
// A Machine is driven by repeated calls to Tick. It never assumes leadership
// from a lease that may still be valid: an existing lease can only be replaced
// after the local clock has moved past its expiration by the configured clock
// skew bound. The store contract is compare-and-swap based, so a stale leader
// cannot overwrite the lease of a newer leader even if it wakes up late.
// Callers should also pass Term to external resources as a fencing token; a
// paused in-flight operation cannot be revoked by IsLeader alone.
//
// The package is deliberately free of background goroutines and uses an
// injectable Clock. This makes renewal loss, resource version conflicts,
// partitions, and worst-case clock skew deterministic to test.
package formal
