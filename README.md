# raftsim

A deterministic, message-event-driven simulation of Raft-style log
replication on a three-node cluster. Pure Go standard library; no real
network, no timers, no goroutines — every state transition is an explicit
message delivered by the `Simulator`.

## Design

- `Node` (`raft.go`): a Raft server (Follower/Candidate/Leader) handling
  `RequestVote`, `VoteResp`, `AppendEntries`, `AppendResp`, and `Timeout`
  messages. Terms are monotonic; leaders only commit current-term entries
  by majority replication (Raft §5.4.2); followers truncate uncommitted
  conflicting suffixes on `AppendEntries`.
- `Sim` (`sim.go`): a FIFO queue of explicit messages plus a partition
  mask. `Timeout`, `ClientWrite`, `Heartbeat`, `Partition`, `DeliverNext`,
  and `Drain` are the only ways to advance the system. Every step is
  appended to `Sim.Trace`; every leader commit produces a
  `CommitEvidence` (term, index, command, quorum).
- Safety checker (`Sim.CheckSafety`): term monotonicity per node, no
  truncation of committed entries (instrumented at the truncation site),
  and committed-prefix agreement across all nodes.

## Tests

- `TestElectAndReplicateCommit` — election + 3 writes, full trace, 3 commit
  evidences with majority quorums.
- `TestOldLeaderRecoveryTruncatesUncommitted` — isolated old leader accepts
  an uncommitted write; after healing, the new leader's log overwrites the
  conflict and the stale entry is truncated, committed prefix intact.
- `TestStaleLeaderCannotOverwriteCommitted` — a stale-term `AppendEntries`
  is rejected; committed entries are never covered.
- `TestEnumerateShortPartitionHistories` — BFS model checking with state
  dedup: all interleavings of deliveries, timeouts, client writes, and
  short partition histories (7 partition configs, injected near the root),
  checking safety in every visited state.
- `TestEvidenceCoversEveryCommit` — every committed index on every node is
  backed by recorded quorum evidence.

Run:

    go test ./...          # all tests
    go test -v -run TestOldLeaderRecovery .   # see the per-step trace
