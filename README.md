# trendlib

Bitemporal trend library for integer samples with exact rational
linear-regression queries. Go standard library only.

## Semantics

- **Samples** are `(time, value)` integer pairs; duplicate timestamps are
  allowed and participate individually.
- **Query** over the half-open business-time range `[lo, hi)` at a commit
  version returns the least-squares slope and residual sum of squares as
  exact `*big.Rat` fractions. Samples at `lo` are included, samples at `hi`
  excluded. When a range edge falls between samples, a linearly
  interpolated fractional point (duplicates averaged) is added to the
  statistics. Zero x variance (fewer than two distinct x values) yields a
  nil slope; the RSS is then the squared deviation from the mean.
- **Corrections** replace all samples in a half-open range and take effect
  from the version their batch is committed. Historical version queries
  never observe future corrections.
- **Index** keeps, per version, an immutable snapshot of samples sorted by
  business time plus prefix regression aggregates (n, Σx, Σy, Σx², Σxy,
  Σy²), so a range query is a prefix difference plus edge points.
- **Store** persists batches durably: the batch data file is written and
  synced before the root pointer is atomically renamed into place, so crash
  recovery always finds either the old or the new root, never a partially
  published batch. Orphaned batch files newer than the root are ignored on
  recovery.

## Testing

`go test ./...` cross-checks the index against an independent direct
rational-summation model over a two-dimensional grid of business-time
ranges x commit versions, and verifies atomic batch publish/recovery via
injected crash failpoints.
