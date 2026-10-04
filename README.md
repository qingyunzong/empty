# tri-merge

Three-way merge library (TypeScript, Node.js built-ins only, zero dependencies).

## Core idea

- `merge3({ base, ours, theirs, resolutions })` merges two branches against a
  common base, field by field (recursing into plain objects; arrays and
  scalars are atomic).
- Every conflict is reported with full **provenance**: the base/ours/theirs
  values at the field path and their sha256 digests (`ConflictInfo`).
- Each **resolution choice binds both sides' source digests**
  (`Resolution.oursDigest` / `theirsDigest`, plus `baseDigest`) captured via
  `makeResolution(path, choice, sources)`.
- After sources change, recompute with the same resolution book: only choices
  whose bound digests still match are kept and applied; stale choices are
  dropped and their conflict **reopens** (`status: "reopened"` with
  `staleReason: "ours-changed" | "theirs-changed" | "both-changed"`).
- Resolutions are keyed by exact field path, so **different fields resolve and
  carry over independently** — editing `title` never invalidates a resolution
  on `count`, and a resolution on `profile.name` survives edits to
  `profile.age`.
- The result includes the **final diff** (`base -> merged`) as `set`/`remove`
  ops; `applyDiff(base, result.diff)` reproduces `result.merged`.

## API

```ts
import { merge3, makeResolution, applyDiff } from "tri-merge";

const first = merge3({ base, ours, theirs });
// first.conflicts -> ConflictInfo[] with provenance + digests
const resolutions = first.conflicts.map((c) =>
  makeResolution(c.path, { kind: "theirs" }, { base, ours, theirs }),
);
const settled = merge3({ base, ours, theirs, resolutions });
// settled.clean === true; settled.diff is the final diff
```

Choices: `{ kind: "ours" | "theirs" | "base" }` or `{ kind: "custom", value }`.

## Layout

- `src/json.ts` — canonical JSON, sha256 digest, path helpers
- `src/resolution.ts` — digest-bound resolution type, matching, picking
- `src/merge.ts` — `merge3` core, conflict provenance, stale reopening
- `src/diff.ts` — final diff computation and application
- `test/merge.test.ts` — unit tests (provenance, staleness, independence, diff)
- `test/random.test.ts` — seeded randomized branch updates + recompute checks

## Tests

`npm test` compiles with `tsc` and runs `node --test`.

Actual recorded result (Node v22.22.1, tsc 7.0.2):

```
# tests 2   # pass 2   # fail 0        (dist/test/merge.test.js, dist/test/random.test.js)
randomized recompute check: {"rounds":300,"conflicts":245,"applied":65,"kept":65,"reopened":47,"vanished":2}
```

The randomized round-trip runs 300 seeded rounds: merge two randomly edited
branches, resolve every conflict with a random choice, apply random branch
updates, then recompute and cross-check against an independent oracle — kept
resolutions must be digest-valid and applied, stale ones must reopen, and the
final diff must reproduce the merged document.
