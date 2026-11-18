// Package formal implements a lease manager for objects that are opened and
// written back by competing clients.
//
// The manager grants an exclusive lease per object. Every lease carries a
// monotonic fencing epoch (Lease.Epoch) that is bumped on each ownership
// transfer. The storage layer (FencingStore) rejects any write whose epoch is
// not strictly greater than the highest epoch it has already accepted, so:
//
//   - at most one client holds write permission for an object at any instant;
//   - a renew/steal race resolves to exactly one outcome, never both;
//   - interrupting (Break) or stealing a dirty lease flushes buffered data
//     before the lease is released or transferred, and that flush happens
//     exactly once even under interleaving (no double write);
//   - an old lease receipt whose epoch has been superseded is rejected with
//     ErrStaleToken and can never block or overwrite the new holder.
//
// Each public operation is expressed as an ordered list of idempotent steps.
// Production callers execute those steps under one mutex; the tests execute
// the same steps without the lock to exhaustively enumerate interleavings and
// cross-check every micro-boundary against a hand-written naive lease table.
package formal
