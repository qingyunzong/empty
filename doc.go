// Package formal implements the commit protocol used by the training
// framework's checkpoint flow.
//
// A checkpoint step is committed in two phases:
//
//  1. Every rank uploads an immutable shard. A shard lives under a key that
//     contains the step, the commit generation, and the rank, so retries and
//     late arrivals can never overwrite a different attempt.
//  2. A coordinator verifies that every expected shard is visible, decodes its
//     header, checks that the header belongs to the same step and generation,
//     and only then publishes the manifest with an if-none-match write. The
//     manifest therefore transitions from "absent" to "complete" atomically.
//
// The Store contract requires linearizable conditional writes but permits
// eventually consistent reads. Callers that observe a successful write may
// still need to retry reads for a while; the helpers in this package do that
// with a bounded RetryPolicy.
package formal
