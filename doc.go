// Package dataeng coordinates DynamoDB Streams shard inheritance for
// collectors and shard schedulers.
//
// The package models the pieces a scheduler needs without depending on an
// AWS SDK:
//
//   - ShardGraph records the parent and adjacent-parent links from
//     DescribeStream and reports children that reference absent parents.
//   - Coordinator refuses to lease a child until every parent is both known
//     and completed. Missing parents cause conservative waiting rather than
//     an optimistic start.
//   - Commit advances the shard watermark and its output acknowledgement in
//     one compare-and-swap operation. A closed shard is completed only once
//     both positions reach its ending sequence number.
//   - Leases carry a monotonically increasing generation. Preemption issues a
//     new generation, so a worker holding an older token cannot renew, release,
//     or commit.
//
// A scheduler can use a Coordinator directly through the ShardScheduler
// interface. Store implementations provide durable, atomic compare-and-swap
// semantics; MemoryStore is an in-process implementation suitable for tests or
// a single collector.
package dataeng
