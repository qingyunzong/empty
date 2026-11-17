// Package formal implements the replica planning rules used by a release
// control plane.
//
// A Planner is fed an Observation of the workload after each action has been
// applied. It returns at most one scaling action for that step. The planner
// keeps a ledger of terminations it has started so that a later capacity
// change, desired-replica change, or readiness change can recompute the next
// action without cancelling an already-started termination.
//
// Replica limits follow Kubernetes rolling-update semantics:
//   - maxSurge percentages are rounded up;
//   - maxUnavailable percentages are rounded down.
//
// The zero Observation.Capacity is a real capacity of zero. Use
// UnlimitedCapacity when the caller does not want to constrain node capacity.
package formal
