// Package formal implements a generation-based membership coordinator for a
// synchronous distributed-training control plane.
//
// A Coordinator assigns contiguous ranks to the active membership, collects
// one gradient contribution per member for the active step, and advances the
// step only after the complete active generation has contributed. A
// reconfiguration freezes the current step, retires the old generation,
// discards its partial contributions, aborts its pending checkpoint barriers,
// and creates a new generation at the same step.
//
// Every gradient, heartbeat, and checkpoint confirmation carries a generation.
// Requests from a retired generation, removed members, stale or future steps,
// and replayed heartbeat sequences are rejected. Consequently a completed step
// is always owned by exactly one generation, and a checkpoint becomes readable
// only after every member of its generation has confirmed it.
//
// The coordinator is in-memory and concurrency-safe. Failure detection,
// persistence, and checkpoint storage are responsibilities of the worker
// manager that drives it.
package formal
