# snapstore

Snapshot-isolated key–value store with immutable published versions and
content-addressed certificates. Built for a data center that publishes
dataset versions for citation in papers: once a version is published, its
content must be reproducible forever; unpublished drafts stay mutable.

Pure Node.js 22 standard library (`node:fs`, `node:path`, `node:crypto`,
`node:test`). No dependencies, single machine, offline.

## Model

- **Draft transactions** read a snapshot taken at `begin()` and buffer
  writes; `commit()` assigns a monotonically increasing version number
  (1, 2, 3, …) and appends the writes to the WAL (`wal.log`).
- **`publish <version>`** freezes that version: it computes a
  content-addressed certificate (SHA-256 over all key/value pairs in
  sorted-key order) and durably writes `published/<version>.cert`
  (tmp file → fsync → rename → dir fsync), then records the publish
  event in the WAL.
- **Freeze constraint**: the union of keys contained in all published
  versions is frozen. A write transaction whose write set touches any
  frozen key is rejected at commit with `FROZEN`. Keys not covered by
  any published version remain writable.
- **Historical reads** by version number or by certificate return
  byte-identical content; certificate reads and `verify` recompute the
  hash and raise `TAMPER` on mismatch.
- **Crash recovery**: a version counts as published iff its cert file
  exists on disk. If a crash interrupts `publish` before the cert is
  durable, the WAL publish event is rolled back during recovery and the
  version stays a draft (re-publishable). If the cert is durable but the
  WAL event is missing, the cert file wins and the version is published.

## Layout

```
<data-dir>/
  wal.log              # append-only: commit + publish events (JSON lines)
  draft.json           # staged CLI draft transaction
  published/
    <version>.cert     # {version, cert, keyCount, publishedAt}
```

## CLI

```
node src/cli.js [--dir PATH] <command> ...

put <key> <value>                        stage a write in the draft transaction
commit                                   commit the draft as a new version
discard                                  drop the staged draft transaction
publish <version>                        freeze a version, print its certificate
get <key> [--version N | --cert HEX]     read a key (default: latest state)
verify [--version N | --cert HEX]        verify a published version's certificate
status                                   show current and published versions
```

Exit codes: `0` ok, `1` general error, `2` FROZEN, `3` NO_VERSION,
`4` NO_KEY, `5` TAMPER. Error messages are prefixed with the error code
(`FROZEN: …`, `NO_VERSION: …`, `TAMPER: …`).

For crash-injection testing, `SNAPSTORE_CRASH_AT=before-cert|after-cert`
makes `publish` exit abruptly (code 70) at the chosen point.

## Library

```js
import { openStore } from './src/store.js';

const store = openStore('./data');
const txn = store.begin();
txn.put('dataset/users', 'alice,bob');
const version = txn.commit();          // -> 1
const cert = store.publish(version);   // sha256 hex, freezes the version

store.getAt('dataset/users', 1);       // read by version
store.getPublished('dataset/users', { cert }); // read by certificate
store.verify({ version: 1 });          // -> { version, cert } or TAMPER
store.close();
```

## Tests

Run with `node --test` (Node 22). The suite covers the three acceptance
scenarios plus error conventions:

```
ok 1 - scenario 1: publishing v3 freezes its keys; untouched keys stay writable
ok 2 - scenario 2: crash mid-publish (cert not durable) leaves version as draft, re-publishable
ok 3 - scenario 2b: crash after cert is durable recovers as published
ok 4 - scenario 3: 10 consecutive publishes, sampled keys match publish-time snapshots
ok 5 - NO_VERSION for unknown versions and certificates
ok 6 - TAMPER when stored content no longer matches the certificate
ok 7 - reads by version and by cert are byte-identical to publish-time content
ok 8 - CLI end-to-end: put/commit/publish/get/verify and error conventions
# tests 8
# pass 8
# fail 0
```

Result recorded on 2026-10-03 with Node v22.22.1: **8/8 passing**
(`node --test` → `pass 8, fail 0`).

Notes on test methodology:

- Crash injection is simulated in-process (`openStore(dir, { crashMode:
  'throw' })` + `publish(v, { crashAt })`): the store instance is
  abandoned without `close()` — no flush, no cleanup — exactly like a
  power loss. The same injection point is available to the real CLI via
  `SNAPSTORE_CRASH_AT` (verified manually: exit 70, no cert file,
  version stays draft, re-publish succeeds).
- Scenario 3 uses a deterministic LCG (seed 42) to sample keys; every
  published version's full snapshot is also compared to the
  publish-time reference with `assert.deepEqual`.
- The CLI is exercised in-process through its exported `run(argv, io)`
  entry (the sandbox here forbids grandchildren processes under
  `node --test`); the same code path runs standalone as
  `node src/cli.js`.
