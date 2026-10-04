# evidence-verifier（核验库）

Cross-checks three evidence sources of a run — the result manifest
(`manifest.jsonl`, 结果清单), the trajectories (`trajectory.jsonl`, 轨迹) and
the file summaries (`filesummary.jsonl`, 文件摘要) — item by item, verifying
that **运行ID (`runId`)**, **题面摘要 (`problemSummary`)** and **阶段来源
(`stageSource`)** agree everywhere.

- **缺失证据 → `unknown`**: an item missing from a source, a missing field, an
  unparseable line, or a missing source file.
- **矛盾 → `conflict`**: two present values disagree (or a duplicate record).
- **最小冲突对**: per field, values are grouped; exactly one representative
  citation pair is emitted per pair of disagreeing groups — the smallest
  complete witness set of the contradiction.
- **引用范围**: every citation carries `file:line:colStart-colEnd`; the column
  span slices exactly the JSON string token of the checked field.

Pure TypeScript + Node.js built-ins (`node:fs`, `node:path`, `node:test`,
`node:assert`, `node:child_process`). Zero npm dependencies; the ambient
declarations in `types/node-shims.d.ts` cover the used built-ins because the
offline environment has no `@types/node`.

## Usage

```sh
npm run build                       # tsc -> dist/
node dist/src/cli.js <dataset-dir>  # text report
node dist/src/cli.js <dataset-dir> --json
```

Exit codes: `0` fully consistent, `1` at least one 矛盾 (conflict),
`2` only 未知 (unknown), `3` usage error.

Each JSONL line: `{"itemId","runId","problemSummary","stageSource"}`.

## Acceptance (验收)

`npm test` covers:

- golden dataset → all `consistent`, exit 0;
- **删项**: item deleted from one source → `unknown` with `missing-item`
  citations, untouched items stay consistent; whole source file deleted →
  every item `unknown`;
- **随机篡改**: 30 seeded rounds tampering a random (source, item, field) →
  exactly one `conflict`, the minimal conflict pair cites the tampered
  file/line, and the cited column span slices exactly to the tampered JSON
  value; per-field tampering of `runId` / `problemSummary` / `stageSource`;
- three distinct values → three minimal pairs (all group pairs);
- CLI end-to-end exit codes 0 / 1 / 2.

## Actual test results（实测记录）

Environment: Node.js v22.22.1, tsc 7.0.2, Linux x86_64. `npm test` run on
2026-10-05:

```
# tests 8
# pass 8
# fail 0
```

Individual cases (all `ok`):

1. fully consistent dataset yields all-consistent and exit 0
2. deleting an item from one source marks it unknown, not conflict
3. deleting a whole source file marks every item unknown
4. tampering a random field is always detected with a citing conflict pair (30 seeds)
5. tampering each checked field (runId/题面摘要/阶段来源) is caught
6. three distinct values yield three minimal pairs (all group pairs)
7. locateField slices the exact JSON string token
8. CLI end-to-end: exit 0 on consistent, 2 on unknown, 1 on conflict

Note: the sandbox drops piped child-process stdout, so the CLI end-to-end
test redirects the child's stdout to a temp file instead of a pipe.

## Demo

`node dist/src/cli.js examples` (exit 1) — `examples/` contains one
consistent item, one item deleted from `filesummary.jsonl` (unknown) and one
tampered `runId` in `trajectory.jsonl` (conflict with a minimal pair citing
`examples/manifest.jsonl:3:30-48 <-> examples/trajectory.jsonl:3:30-55`).
