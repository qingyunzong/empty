// Package formal implements a deterministic rendezvous coordinator for
// distributed-training startup.
//
// The coordinator maintains a single authoritative membership view. Every
// change to that view (a join, a crash report, a reconnect, or a deadline
// expiry) opens a new generation, assigns ranks from the sorted membership
// table, and waits for confirmations from every member of that generation.
//
// Protocol rules:
//
//   - A generation is the only valid target for a confirmation. A
//     confirmation carries the generation number it belongs to.
//   - Within one generation ranks are unique, contiguous, and equal to the
//     member's index in the lexicographically sorted membership table.
//   - A generation commits only when every member of that generation has
//     confirmed strictly before its deadline. Commit happens immediately on
//     the final confirmation; it does not wait for the deadline.
//   - If the deadline is reached first, the generation aborts. Members that
//     did not confirm are treated as failed and removed. The remaining
//     members form a new generation and must confirm again.
//   - Confirmations never carry over between generations. A confirmation for
//     an old generation is rejected as stale, even if the same member is
//     present in the current generation.
//
// All methods accept the caller's view of the current time. This keeps the
// state machine deterministic and lets callers, tests, and fault simulators
// reproduce event interleavings exactly. Times are clamped to be
// non-decreasing; a method is safe to call from multiple goroutines, but
// concurrent calls are serialized in an unspecified order.
package formal
