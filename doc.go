// Package formal implements coordination for online secondary-index builds.
//
// A build has three boundaries:
//
//   - Snapshot: a transactionally consistent table scan at commit sequence W.
//   - Drained: every commit with W < Seq <= Drained has been applied to the
//     index.
//   - Barrier: the commit sequence certified by Seal.
//
// The handoff is seamless because commit sequences are assigned at commit
// time, not at transaction start. A transaction that began before W but
// committed after W has Seq > W, so it is absent from the snapshot and present
// in the change log. Conversely, a transaction committed at or before W is in
// the snapshot and is excluded from replay. Provided the snapshot is atomic and
// the log is complete for the table, replaying (W, Drained] over the snapshot
// reproduces the table exactly at Drained.
//
// # Visibility protocol
//
// Scan -> CatchUp* -> Seal -> Publish.
//
// Seal captures the log high watermark V, drains through V, and runs the
// configured Auditor against the table at V. Only then does it issue an opaque
// Certificate. Publish rejects certificates from other builds and rejects a
// certificate if the log advanced past V; the caller must Seal again to cover
// the new commits. A canceled or failed build can never Publish.
//
// Publish's log high-watermark check is the visibility switch point. Callers
// must arrange for commits after that point to maintain the index (for example
// by holding a schema lock or enabling dual writes until the DDL executor has
// installed the new index).
//
// # Replay
//
// Replay is at-least-once. The coordinator ignores duplicate and stale commit
// sequences, applies each commit's changes as one uninterrupted unit, and
// treats Put/Delete as idempotent. A transaction's changes never become
// partially visible.
//
// # Verification
//
// Compare checks an index against an authoritative snapshot and reports
// missing keys, ghost keys, and value mismatches. SnapshotAuditor uses Compare
// at the certificate barrier, and the schedgen package generates deterministic
// transaction schedules for model-based verification.
package formal
