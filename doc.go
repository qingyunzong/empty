// Package taskpool implements a bounded pool for compute tasks with
// ticket-based lifecycle control.
//
// A Pool admits at most a fixed capacity of in-flight tasks. Submitting a
// task returns a Ticket whose fate is decided by exactly one of three
// competing events: cancel, start, or claim. A ticket therefore reaches
// exactly one terminal state:
//
//   - Cancelled: cancelled while still pending; it never runs and its
//     capacity returns to the pool.
//   - Claimed: it ran to completion and its result was claimed exactly
//     once. After a claim, Cancel fails.
//
// Cancelling a running ticket only signals the task's context; the task
// still runs to completion. Closing the pool releases every waiter:
// blocked Submit calls fail with ErrClosed and running tasks receive a
// cancellation signal.
package taskpool
