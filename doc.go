// Package formal provides the coordination ledger used by a deletion
// controller's terminal-cleanup path.
//
// An object may carry several terminal keys (finalizers). Keys are registered
// in order and are retired in that same order. Every key names the external
// resources whose cleanup must be confirmed before the key can be removed.
// Confirmations are idempotent: no matter how often an external operation
// reports success, or how it races with a delete event, the ledger records at
// most one successful cleanup per resource.
//
// Registration is additive. Registering a key that is already present (even
// one that was previously removed) never resets the state of resources that
// already completed. This lets a controller re-add a terminal key while an
// object is terminating without repeating side effects.
//
// The ledger is also an event-sourced state machine. Every externally supplied
// event is retained, and Replay reconstructs the exact same state from that
// log. Tests and controllers can therefore enumerate fault points, stop at any
// point, and replay the durable prefix.
package formal
