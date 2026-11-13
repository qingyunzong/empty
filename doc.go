// Package dataeng coordinates consistent Modbus register snapshots.
//
// A Coordinator performs one bounded device round at a time. Every configured
// interval is read inside that round's context. Overlapping intervals are
// merged only when their values agree; a disagreement rejects the complete
// round. A failed interval may be retried without re-reading successful
// intervals, but retries share the original round deadline.
//
// When a restart-counter register is configured, a change between successful
// rounds increments Snapshot.Generation. A reader may also report the restart
// counter with each interval; disagreement inside one round invalidates that
// round because it spans device generations.
package dataeng
