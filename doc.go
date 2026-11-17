// Package formal implements the aggregation library backing the
// autoscaling control plane. It is built for HPA extender calls: it
// aggregates several metrics across pods, tolerates missing metrics and
// unready pods, applies independent scale-up/scale-down stabilization
// windows and rate policies, and evicts expired recommendation history
// precisely. Controller maintains state incrementally; Naive recomputes
// from a full event replay and serves as the consistency reference.
package formal
