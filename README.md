# history-redact

Offline history-redaction rewriter for a scientific data warehouse. Pure
JavaScript, Node.js >= 22, standard library only (`node:test` for tests).

A repository history is a JSON sequence of commits. Each commit carries a
structured patch, an author, a message, and (after rewriting) the file-content
hashes and the commit hash. Rewriting replaces sensitive values that match
configured rules with stable tokens and recomputes every commit hash, so the
entire downstream history is rewritten.

## Data model

```jsonc
// history.json
{ "commits": [
  {
    "author": "alice",
    "message": "import cohort for SUBJ-001",
    "patch": [
      { "file": "cohort.csv", "hunks": [
        { "op": "insert", "context": "", "position": "after", "text": "..." },
        { "op": "replace", "old": "...", "new": "..." },
        { "op": "delete",  "old": "..." }
      ]}
    ]
  }
]}
```

Hunk anchors (`context` / `old`) must occur exactly once in the current file
content, otherwise the hunk cannot be located.

## Hash specification

```
fileHash(f)   = sha256hex(utf8 content of f)
commitHash(c) = sha256hex(canonicalJson({
  parent:  <previous commit hash, or null>,
  author:  c.author,
  message: c.message,
  patch:   c.patch,
  files:   { <path>: fileHash, ... }   // full snapshot after applying c
}))
```

`canonicalJson` sorts object keys recursively and emits no whitespace. Hashes
are always recomputed per this specification during a rewrite, even when no
sensitive value was found.

## Rules

```jsonc
// rules.json
[
  { "name": "subject-id", "pattern": "SUBJ-\\d{3}" },
  { "name": "pi",         "values": ["alice@lab.org"] },
  { "name": "fixed",      "values": ["A", "B"], "token": "FIXED" } // optional fixed token
]
```

The same original value maps to the same token across all commits, patches and
messages (default token: `«REDACTED:<sha256(value)[:16]>»`). If two distinct
original values would map to the same token, the rewrite aborts.

## CLI

```
node bin/history-redact.js rewrite --history history.json --rules rules.json \
    [--out-history out.json] [--out-manifest manifest.json]
node bin/history-redact.js verify --history history.json
```

`rewrite` writes `<name>.rewritten.json` and `<name>.manifest.json` next to the
input by default. The manifest records the old→new hash mapping for every
commit, the token map, and an invalidation proof binding old tip, new tip,
mapping and tokens into a single `proofHash`.

Exit codes:

- `0` success
- `1` usage / I/O error or history integrity failure
- `2` rewrite aborted — token collision, patch context unlocatable after
  substitution, or final-state projection mismatch. Nothing is written; the
  original files are left untouched.

## Safety property

Replaying the rewritten history version by version reproduces the original
final state under the redaction projection (every sensitive value replaced by
its token). The rewriter verifies this internally before writing anything and
aborts with exit code 2 on mismatch.

## Library

```js
import { rewriteHistory } from './src/redact.js';
const { commits, manifest, tokenMap } = rewriteHistory(commits, rules, {
  tokenize: (value) => `TOKEN-${value}`, // optional, for custom token schemes
});
```

## Tests

```
node --test
```

Covers multi-version consistent replacement, token-collision abort, hash
recomputation without sensitive values, CLI exit codes / file untouched
guarantees, and enumerates all 3! replacement bijections over ≤ 3 values as a
control.
