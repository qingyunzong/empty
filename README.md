# signflip-exact

Exact sign-flip permutation test for paired differences, in TypeScript on
Node.js built-ins only (no runtime dependencies).

## Model

- Input: up to **20** paired differences, each an exact rational
  (`"3/4"`, `"-2"`, `"1.25"` all accepted), each tagged with a sample id.
- Statistic: **|mean of the paired differences|**. Since n is fixed across
  reassignments, comparisons are done on |sum| exactly.
- Two-sided p: the proportion of **all** sign reassignments whose statistic
  is **>=** the observed statistic.
- A zero difference carries **one** sign only, so with z zeros the
  enumeration has 2^(n-z) assignments.
- Repeated values are still distinct samples (keyed by sample id); the
  compressed engine groups equal values and counts them with exact binomial
  multiplicities, and the naive engine re-enumerates every assignment to
  cross-check the count.

## Confidence set for a shift delta

Given up to **12** candidate rational shifts, each candidate delta is
subtracted from every difference, the full enumeration is re-run, and delta
enters the confidence set iff `p_delta > alpha` (strict; alpha rational).

## Withdrawal and checkpointing

- `withdraw(samples, ids)` removes samples by id (unknown ids are errors).
- `runWithCheckpoint(samples, path, { chunkSize, maxChunks })` persists
  progress (next mask + running count, keyed by a SHA-256 of the input)
  after every chunk; re-running with the same path resumes. A checkpoint
  that does not match the input is rejected. The file is removed on
  completion.

## Certificate

`certify` emits a JSON counting certificate: canonical input hash, n,
zero/nonzero counts, observed sum and statistic, `countGE`, `total`, exact
p, both engines' counts, whether they agree, and a SHA-256 digest of the
whole record.

## Usage

```
npm test                 # compile + run the test suite
node dist/src/cli.js examples/job.json
```

Job file:

```json
{
  "samples": [{"id": "p01", "diff": "1/2"}, ...],
  "withdraw": ["p08"],
  "candidates": ["0", "1/4", "1/2"],
  "alpha": "1/10",
  "checkpoint": "/tmp/cp.json",   // optional, enables resumable run
  "chunkSize": 65536,             // optional
  "maxChunks": 4                  // optional, bounds work per invocation
}
```

## Verified results (recorded from actual runs)

- `npm test` (tsc 7.0.2, Node v22.22.1): **19 tests, 19 pass, 0 fail**
  - `test/rational.test.js`: 3 pass
  - `test/enumerate.test.js`: 9 pass
  - `test/confidence.test.js`: 7 pass
- Hand-checked cases: `[1,2,3]` -> p = 1/4; four equal diffs -> p = 1/8;
  `[1/2,1/3]` -> p = 1/2; `[0,5]` -> total 2 (zero carries one sign), p = 1.
- Randomized cross-check: 40 random inputs (n <= 12, repeated values and
  zeros) — naive and compressed engines agree on every count.
- Checkpoint: interrupted run (maxChunks=2) then resume reproduces the
  uninterrupted count exactly (p = 55/256 on the 12-sample example).
- Full scale: n = 20 (one zero, 2^19 assignments) plus 12 candidate shifts,
  each cross-checked by both engines: ~13.5 s total.
