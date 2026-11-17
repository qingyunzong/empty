// Package formal implements a small resource-orchestration execution engine.
//
// A Plan is a dependency DAG of resource operations (create, update or delete).
// The executor applies independent nodes concurrently. If an operation fails,
// only nodes whose effect was committed and which are marked reversible are
// compensated, in reverse dependency order. Every execution carries an
// operation generation; completions delivered for an older generation are
// fenced off and can never advance a newer plan.
package formal
