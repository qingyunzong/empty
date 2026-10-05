# seglib

Message segment log with per-consumer acknowledgement tracking. Go standard library only.

## Semantics

- **Acked ranges**: each consumer's acks form a merged interval set; its position is the
  contiguous acked prefix from its registration offset. Out-of-order acks are buffered and
  only advance the position once the gap fills.
- **Persistent exit records**: `Cancel` atomically writes a tombstone to `exited.json`.
  Reopening the store (restart) reloads it, so a cancelled consumer can never be
  re-registered and its retention point is never resurrected.
- **Reclamation**: `Reclaim` drops whole segments ending at or below the minimum
  contiguous prefix across all active consumers. With no active consumers it is a no-op.
- **Replay**: `Replay` yields surviving messages at or after a consumer's prefix.

## Tests

`go test ./...` runs deterministic unit tests plus a randomized simulation
(`TestReplayAgainstSetModel`, 5 seeds x 800 ops incl. restarts) that checks every
observable against a naive set-based reference model. See TEST_RESULTS.md for the
recorded run.
