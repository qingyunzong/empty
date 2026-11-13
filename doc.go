// Package dataeng coordinates Kafka partition processing across cooperative
// consumer-group rebalances.
//
// A [Coordinator] owns one worker per assigned partition. Each worker turns a
// fetched slice of records into an output batch, hands the batch to a [Sink],
// and only then commits the partition offset. Every step is recorded in a
// [Journal] before it is acknowledged, so an interrupted process can recover
// without losing a batch and, when the sink is idempotent by batch ID, without
// duplicating one.
//
// Cooperative rebalances are incremental: [Coordinator.Assign] and
// [Coordinator.Revoke] may be called with only the partitions that changed.
// Revoking a partition stops its reader, then waits for the batch that is
// already in flight. Every batch carries the lease (generation and epoch) it
// was produced under. A sink callback that arrives after the lease was
// revoked, lost, or re-assigned is journaled as fenced and can neither commit
// an offset nor advance the new owner's watermark.
package dataeng
