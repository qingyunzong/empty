# threshold-calibrator

CLI that picks one acceptance threshold per group (1–8 groups) for samples
with integer scores and ground-truth labels, subject to a global false-positive
budget.

## Objective

1. Total FP across all groups must be `<= budget`.
2. Among feasible threshold vectors, minimize total FN.
3. Break remaining ties by the lexicographically smallest threshold vector
   (compared group by group, in input order).

Acceptance rule: a sample is accepted iff `score >= threshold`. Decisions
depend only on the score, so tied scores always receive the same decision.
The candidate domain per group is the set of distinct scores plus
`maxScore + 1` (reject-all); any other integer threshold is
outcome-equivalent to one of these, which makes the lexicographic
tie-break well-defined.

## Install / build / test

No runtime dependencies. Requires Node.js >= 18 and a `tsc` compiler.

```sh
npm run build   # compile TypeScript to dist/
npm test        # compile + run the node:test suite
```

## Usage

```sh
node dist/src/cli.js input.json
cat input.json | node dist/src/cli.js --budget 3 --version 2
node dist/src/cli.js --help
```

### Input

```json
{
  "budget": 2,
  "version": 1,
  "groups": [
    {
      "name": "model-a",
      "samples": [
        { "id": "s1", "score": 7, "label": true },
        { "id": "s2", "score": 3, "label": false, "since": 1 },
        { "id": "s3", "score": 9, "label": false, "until": 2 }
      ]
    }
  ]
}
```

- `budget` (required): non-negative integer, global FP budget.
- `version` (optional): snapshot version; defaults to the latest version
  mentioned in the input.
- `groups`: 1 to 8 groups; `label` is `true/false` or `1/0`; scores are
  integers.

### Sample versioning (add/remove)

Each sample may carry `since` and `until` version fields. A sample is active
at version `v` iff `since <= v < until` (missing `since` = 0, missing
`until` = never removed). Adding a sample in a new version = a new record
with `since`; removing one = setting `until`. `--version` selects the
snapshot to calibrate.

### Output

JSON with:

- `thresholds`: chosen threshold per group (input order).
- `groups`: per-group `confusion` matrix `{tp, fp, tn, fn}` and threshold.
- `totals`: summed confusion matrix.
- `certificate`: DP optimality certificate:
  - `groups[].options`: every candidate threshold with its `(fp, fn)` cost,
    plus the chosen option index — enough to re-verify the DP recurrence
    `dp[i][b] = min over options (fn + dp[i+1][b - fp])` independently.
  - `dp.table`: the full suffix-DP table (included up to 50k cells).
  - `exhaustive`: small-domain brute-force enumeration of the full
    threshold-vector product space (up to `--verify-limit` combinations,
    default 2,000,000) with `matchesDp: true` when the exhaustive optimum
    confirms the DP result.

Flags: `--budget N`, `--version N`, `--verify-limit N` (0 disables the
exhaustive check), `--compact`, `--help`. Exit code 1 on invalid input.
