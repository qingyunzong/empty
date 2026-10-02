# plate-qc-incremental

Incremental QC computation for microplate experiments. Node.js 22, standard
library only, offline.

## Model

- Wells hold raw absorbance (`well:<plate>:<well>`).
- Plate-level control nodes reference positive/negative control wells
  (`negCtrl:<plate>`, `posCtrl:<plate>`).
- Derived per well: negative-corrected value (`corr:`) and positive ratio
  (`ratio:`); per plate: mean of corrected values (`plateMean:`).
- Replicate groups reference wells as `<plate>/<well>` and derive a mean
  (`repMean:`) and coefficient of variation (`repCV:`, population SD / mean).

Dynamic topology changes (control correction, moving wells between replicate
groups, plate mapping edits) only recompute the affected wells, groups and
plates. Every mutation returns a `diff` (before/after per changed node) and a
`certificate` (`seq`, `op`, `invalidated` set, `changed` set, state `hash`).

## Errors and invalid nodes

- Missing control well or empty replicate group -> `E_QC` on the node, and the
  error propagates to all dependent nodes.
- CV (or ratio) with a zero denominator is marked `invalid` (value `null`).
- Undo/redo use an operation stack; a new edit after undo clears the redo
  stack.

## CLI

Reads a JSON op script from stdin, writes results as JSON to stdout:

```sh
echo '{"ops":[{"op":"addPlate","plate":"P1"},{"op":"addWell","plate":"P1","well":"A1","absorbance":0.5},{"op":"snapshot"}]}' | node cli.js
```

Ops: `addPlate`, `addWell`, `removeWell`, `setAbsorbance`, `setControl`
(`kind`: `neg`/`pos`), `addReplicate`, `removeReplicate`, `moveWell`,
`undo`, `redo`, `snapshot`.

## Tests

```sh
node --test
```

The differential test compares the incremental engine against a full
re-enumeration reference (`src/reference.js`) after every op: values, invalid
sets and certificates.
