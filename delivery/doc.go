// Package delivery provides durable bookkeeping for AMQP 1.0 transfer
// deliveries on an inbound link.
//
// A delivery Record correlates the AMQP delivery-tag and delivery-id with the
// link generation (epoch) on which the transfer arrived, and tracks whether
// the delivery is settled, its terminal outcome, any enclosing transaction and
// whether the business payload has been committed to durable storage.
//
// The Tracker enforces the connector's safety rules:
//   - Every link (re)attach opens a new generation via BeginGeneration;
//     dispositions carrying a retired epoch are rejected, so a late
//     disposition from a dead link can never touch the new generation.
//   - Incoming deduplicates transfer retries by delivery-tag: business data is
//     persisted at most once per tag, including after a reconnect.
//   - An accepted outcome is only produced after the Commit callback has
//     durably stored the payload; redeliveries of an already committed
//     delivery skip the callback.
//   - Transactional deliveries keep no outcome until the transaction is
//     discharged; commit yields accepted outcomes, rollback returns the
//     deliveries to unsettled.
//
// Reconcile lists the durable unsettled records used to rebuild the unsettled
// map when the link is resumed after a disconnect.
package delivery
