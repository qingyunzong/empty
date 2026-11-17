// Package formal provides a coalescing work queue for Kubernetes-style
// controller reconciliation loops.
//
// Events for one object are merged by resource version. The highest observed
// version wins, so out-of-order watch deliveries and stale update events cannot
// overwrite a newer update or deletion tombstone. A queue delivers at most one
// event per object concurrently, and never repeats a watch version unless a
// reconciler explicitly calls Fail to request a backoff retry.
//
// Delivery is controlled by a global token bucket and a per-namespace token
// bucket. Both must have a token before an event is handed to a reconciler.
// Ready namespaces are scheduled round-robin, which prevents a busy namespace
// from starving a cold one.
package formal
