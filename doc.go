// Package formal implements fair, leased, reentrant locks with fencing tokens
// for a coordination service.
//
// A Client owns one leased session. Lock requests are serialized by the
// service with a monotonically increasing sequence number and granted in FIFO
// order. Once a client owns a lock, further Acquire calls for the same lock
// are reentrant: they return immediately, share the existing fencing token,
// and add a recursion level.
//
// Every ownership transfer receives a fresh, strictly increasing Token. A
// protected resource should validate the token with a Fencer before each
// mutation. Tokens are never reused, so a holder whose lease was lost can
// never become valid again.
//
// If a session's lease expires or its connection is lost, the service revokes
// all of its locks, removes its queued requests, and promotes the next waiter.
// A Client refuses new acquisitions with ErrDisconnected until Reconnect opens
// a new session. Late or duplicated notifications from the old session are
// ignored.
//
// Coordinator is an in-memory Backend used for tests and single-process
// integrations. FakeClock and Coordinator.Disconnect make lease expiry and
// connection loss deterministic. Notifications are treated as at-least-once;
// Client.Deliver is idempotent.
package formal
