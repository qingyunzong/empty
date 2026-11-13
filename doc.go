// Package dataeng provides a resumable server-streaming data export connector.
//
// A Connector binds application record IDs, server resume tokens, batch
// acknowledgement, and a monotonically increasing connection generation.
// Transport failures resume from the last acknowledged token. Records replayed
// at a resume boundary are deduplicated by record version. An invalid token
// starts a new snapshot and produces an explicit reconciliation against the
// previous result instead of silently appending the two snapshots.
package dataeng
