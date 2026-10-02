# audit-chain

Minimal patch tooling for settlement event logs (Node.js 22, stdlib only).

Each event is `{seq, prevHash, hash, body}` with
`hash = sha256(prevHash + canonical(body))`, `canonical` = JSON with
recursively sorted keys. The first event's `prevHash` is 64 zeros (genesis);
`seq` runs consecutively from 1.

## Commands

```
audit verify <log.jsonl>
audit patch <log.jsonl> <fix.json> --out <new.jsonl> --cert <cert.json>
audit check <old.jsonl> <new.jsonl> <cert.json>
audit recover --out <new.jsonl> --cert <cert.json>
```

- `verify` validates seq consecutiveness, chain linkage and every hash;
  prints the root hash.
- `patch` verifies the input, applies `fix.json` (`{patchOps: [...]}` with
  `replaceBody(seq, fields)` (merge) and `void(seq, reason)` (keeps a
  tombstone event; seq/prevHash order is never modified), recomputes the
  chain and atomically commits `<out>` + `<cert>`.
- `check` re-verifies both logs and the certificate: roots, `changedSeqs`,
  `unchangedRanges`, per-change before/after hashes, and that every event
  outside `changedSeqs` has an identical body. Failures name the first seq.
- `recover` classifies the persistence state after a crash: `OLD` (nothing
  committed), `NEW` (committed and consistent) or `MIXED` (partial commit —
  prints a rollback instruction, exit 2; files are never silently mixed).

## Certificate

```json
{
  "version": 1,
  "oldRoot": "...", "newRoot": "...",
  "changedSeqs": [3, 5],
  "unchangedRanges": [[1, 2], [4, 4], [6, 10]],
  "changes": [{"seq": 3, "before": "...", "after": "..."}]
}
```

## Exit codes

| code | meaning |
|------|---------|
| 0    | success |
| 1    | usage / invalid input |
| 2    | recover: mixed state, manual rollback required |
| 9    | broken hash chain |
| 10   | unauthorized seq/prevHash modification |
| 11   | certificate does not match files |

## Crash-recovery protocol

Persistence order with a single commit point:

1. write `<out>.tmp` (fsync)
2. write `<cert>.tmp` (fsync)
3. rename `<out>.tmp` -> `<out>`
4. rename `<cert>.tmp` -> `<cert>`  (commit)

Crash before step 4 leaves either no finals (`OLD`) or exactly one final
(`MIXED` -> rollback). `AUDIT_CRASH_AFTER=new-tmp|cert-tmp|rename-new`
injects a crash for testing.

## Tests

```
node --test
```
