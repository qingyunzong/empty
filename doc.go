// Package formal is a quota planning library for training-platform cluster
// schedulers. Given a hierarchical quota tree and the set of running and
// pending gang jobs, Plan computes the target allocation: guarantees are
// honored and borrowed idle capacity reclaimed (siblings first), higher
// priorities preempt lower ones, the completed work lost to preemption is
// minimized, and ties break in stable fairness order. BruteForce and Verify
// provide exhaustive small-cluster cross-checks of quota honoring, gang
// atomicity, and optimality.
package formal
