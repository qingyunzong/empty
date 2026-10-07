# signflip-exact

Exact sign-flip (randomization) inference for paired differences, in TypeScript
on Node.js built-in modules only (no runtime dependencies).

## Model

- Input: up to 20 paired differences (`MAX_SAMPLES`), each an exact rational
  (`BigInt` numerator/denominator), each tied to a distinct sample id.
- Statistic: absolute value of the mean of the paired differences
  (`abs_mean_paired_difference`). Since `n` is fixed across reassignments,
  comparing `|mean|` is equivalent to comparing `|sum|`.
- Two-sided p-value (`two_sided_ge_observed`): the proportion of all sign
  reassignments whose statistic is `>=` the observed statistic.
- Zero differences have exactly one sign (they contribute a factor of 1, not 2).
- Repeated values are still distinguished by sample id; the compressed engine
  groups equal absolute values and carries exact binomial multiplicities, so
  sample multiplicity is never lost.

## Engines

- `enumerateCompressed` — dynamic programming over distinct absolute values
  with exact `C(m, k)` counts; supports checkpoint/resume per group.
- `enumerateNaive` — plain enumeration of all `2^m` sign assignments
  (`m` = nonzero count); supports checkpoint/resume by assignment index and
  `maxSteps` for interruptible runs.
- Every certificate embeds an independent naive-enumeration cross-check of the
  compressed counts.

## API

```ts
import {
  createDataset, withdraw, analyze, verifyCertificate, confidenceSet,
  enumerateCompressed, enumerateNaive, rational,
} from "./src/index.ts";

const ds = createDataset([
  { id: "p1", diff: "3/2" },
  { id: "p2", diff: "-2" },
  { id: "p3", diff: "0" },
]);

const cert = analyze(ds);            // counting certificate + naive cross-check
console.log(cert.pValue);            // exact rational string, e.g. "3/4"
verifyCertificate(cert);             // re-checks checksum + independent enumeration

const reduced = withdraw(ds, ["p2"]); // sample withdrawal

const cs = confidenceSet(             // up to 12 candidate shifts (MAX_DELTAS)
  ds,
  [rational.parse("0"), rational.parse("1/2")],
  rational.parse("1/10"),             // rational alpha
);
console.log(cs.included);             // deltas with p > alpha (strict)

// checkpoint / resume
enumerateCompressed(ds, { checkpointFile: "ckpt.json" });
enumerateCompressed(ds, { checkpointFile: "ckpt.json", resume: true });
enumerateNaive(ds, { checkpointFile: "n.json", maxSteps: 1000 });
enumerateNaive(ds, { checkpointFile: "n.json", resume: true });
```

## Certificate

`analyze` returns a `Certificate` with: statistic/tail identifiers, the full
sample list (ids + rational diffs), zero/nonzero counts, observed sum and
observed |mean|, repeated-value groups with multiplicities, `tailCount`,
`totalAssignments`, exact `pValue`, an embedded naive-enumeration verification
block, and a SHA-256 checksum over the canonical serialization.
`verifyCertificate` recomputes the checksum and re-runs the naive enumeration
from the certified sample list.

## Tests

```
npm test
```

Type-checks with `tsc`, compiles to `dist/`, and runs `node --test`.
See `TEST_RESULTS.md` for the recorded actual run.
