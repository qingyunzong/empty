# preimage

Go library for exact preimage queries of piecewise affine maps over
finite integer domains.

## Model

- All intervals are canonical half-open integer intervals `[Lo, Hi)`.
- An `Affine` is `f(x) = floor((A*x + B) / C)` with `C > 0`; `A` may be
  negative (direction flip) or zero (constant map). All rounding is floor
  division, computed exactly with big integers.
- A `Map` is a list of `Piece`s whose domains contiguously cover a finite
  half-open domain.

## Features

- `Map.Preimage(y)` returns every input interval whose image lands in the
  output interval `y`, in canonical form.
- `PreimageChain(chain, y, budget)` computes preimages through a composed
  chain layer by layer, traversing every intermediate floor rounding
  instead of merging coefficients. It returns a layer-by-layer `Proof`.
- Result intervals are budget-limited: a non-nil `Token` pauses the query,
  `ResumePreimage` continues it deterministically.
- `Store` keeps immutable, versioned maps; `Patch` commits branch edits as
  a new version without invalidating historical queries.

## Tests

```sh
go test ./...
```

Short-domain tests verify every result value by value against brute-force
references (endpoints and direction flips for single maps, direct
composite evaluation for chains), replay proofs against the chain, and
check that pause/resume under any budget reproduces the unlimited result.
