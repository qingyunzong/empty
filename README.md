# audit-chain

Hash-chain certificates for append/correct batch audit logs. Node.js 22,
standard library only (`node:crypto`, `node:test`).

## Model

- Input JSONL events: `{seq, eventTime, type, acct, amount, ref}` with
  `type` of `append` or `correct`.
- Events are grouped into windows by `eventTime` (`--window-size` ms);
  `seq` (ingest order) determines the hash-chain order.
- A watermark (`max eventTime seen - --lateness`) seals windows whose end
  has passed. Late events for sealed windows are recorded in `appendix`
  with reason `LATE_AFTER_SEAL` and do not change window totals.
- A `correct` event points at an earlier `append` via `ref` and supersedes
  its amount (each seq has at most one effective version; repeated corrects
  form a version chain). A correct with `amount: 0` revokes the amount.
  Refs that are unknown, self-referential, or point to a future `seq` are
  recorded as `DANGLING` errors and processing continues.
- Hash domains are separated by tags: `WHDR` (window head), `WEVT`
  (events), `APPX` (appendix), `ROOT` (report chain).

## Usage

```sh
node cli.js audit build  --in a.jsonl --out r.json [--window-size ms] [--lateness ms] [--naive]
node cli.js audit verify --in r.json
```

- `build` writes `report.json` with `{windows, appendix, errors, root}`.
- `--naive` re-derives every event's amount contribution by replaying the
  full version history from scratch (O(n^2); intended for <=150 events)
  and cross-checks the incremental computation (exit 3 on mismatch).
- `verify` recomputes all hashes from the report and exits 0 on success;
  any tampered field (event, window, appendix, errors, root) exits 4 and
  names the offending window/entry. Usage/IO errors exit 2.

## Tests

```sh
node --test
```
