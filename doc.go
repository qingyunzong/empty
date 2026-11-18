/*
Package formal implements a deterministic, concurrency-safe hierarchical
quota calculator for admission and scheduling.

A Node is a step in a quota tree. A hold placed at a node consumes capacity at
that node and at every ancestor, so nested limits overlap exactly as quota
scopes do in practice. Limits are integer vectors; a resource omitted from a
limit is uncapped at that node, while a present zero is a hard zero.

FairShare performs hierarchical proportional allocation. At each node the
available capacity is divided according to descendant demand, capped by every
node's hard limit and by the share granted by its parent. Integer remainders
use largest-remainder rounding, with stable priority and node-id tie breaks.

Reserve (and its alias Admit) is all-or-nothing admission. TryReserve grants
the largest amount that fits. Commit turns a reservation into an allocation,
and Release returns either kind of hold. Preempt and PreemptBelow reclaim
capacity from the lowest-priority holds first; within one priority the reclaim
is proportional and largest-remainder rounded, so the sum reclaimed is exactly
the requested amount whenever enough capacity exists.

Every mutating operation is atomic. For every resource, allocated plus
reserved never exceeds the hard limit at any node, and Check can be used to
audit the complete accounting from the active holds.
*/
package formal
