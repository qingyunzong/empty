# test-audit-log

Audit library that binds every test record to the exact source it ran
against: **content hash + command + actual exit code**. A record is only
ever evidence for its own hash — stale passes are never spliced into the
verdict for the current artifact.

## Usage

```ts
import { AuditLog, hashFiles, runAndRecord } from "test-audit-log";

const log = new AuditLog();
const hash = hashFiles(["src/main.ts", "src/util.ts"]);

// Records the real process exit code against this exact source hash.
runAndRecord(log, hash, "npm test");

const verdict = log.evaluate(hash, ["npm run build", "npm test"]);
// verdict.status: "pass" | "fail" | "incomplete"
// verdict.missing:   commands with no record for this hash
// verdict.conflicts: same hash+command with both pass and fail exits
// verdict.failures:  commands whose same-hash records all failed
// verdict.staleRecordsIgnored: records for other hashes, excluded
```

## Rules

- Only records whose `sourceHash` equals the judged artifact's hash count.
- Old green records never fill gaps or override failures of a new hash.
- Mixed exit codes for the same hash + command are a conflict and fail closed.
- Any modification to a source file changes the hash and invalidates
  prior records, which then appear under `staleRecordsIgnored`.

## Test

```sh
npm test   # tsc build + node --test
```
