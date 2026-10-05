# interval_index

A C++20 header-only persistent interval index for **single-writer /
multi-reader** workloads. Standard library only, no dependencies.

## Model

- Maps half-open intervals `[lo, hi)` over `int64_t` to values of type `T`.
  Points never assigned have no value (`query` returns `std::nullopt`).
- Segments are stored in an immutable randomized treap (`shared_ptr<const
  node>`). Every update builds a new root that structurally shares all
  untouched subtrees with the previous version.
- Adjacent segments with equal values are always coalesced; coalescing
  never fills an unassigned gap.

## Concurrency protocol

- **Writer (one thread only):** `apply(batch)`, `assign`, `add`. A batch is
  applied to the current root and the result is published with a single
  atomic store (`std::atomic<std::shared_ptr<const node>>`).
- **Readers (any number of threads):** `snap()` performs one atomic load
  and returns an independent `snapshot`. `snapshot::query` /
  `snapshot::segments` never touch shared mutable state.
- **Reclamation safety:** a snapshot keeps every node it can reach alive
  via `shared_ptr`. Nodes replaced by a newer publication are reclaimed
  only when the last snapshot referencing them is destroyed, so queries on
  old snapshots are never affected by node reclamation.

## Composition order of assign / add

Operations inside one batch are applied strictly in insertion order; each
operation observes the result of all previous ones:

- `assign(lo, hi, v)` — every point of `[lo, hi)` becomes exactly `v`,
  regardless of prior operations.
- `add(lo, hi, d)` — `d` is added to the *current* value of every point of
  `[lo, hi)` that has a value. `add` never creates values on unassigned
  points.

Consequences for overlapping ranges:

| sequence            | result on the overlap        |
|---------------------|------------------------------|
| `add` then `assign` | `assign` wins; add discarded |
| `assign` then `add` | assigned value `+ d`         |

## Requirements on `T`

Copy-constructible, equality-comparable (used for coalescing), and
`t + t` valid when `add` is used.

## Complexity

`assign` / `add` / `query`: O(log n) expected. Batch of k ops: O(k log n).
Publish and snapshot: O(1).

## Tests (CMake / CTest)

```sh
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

- `test_basic` — query semantics, composition order, splitting/coalescing,
  gap preservation, structural invariants.
- `test_model` — differential cross-check against a **small-array copy
  model**: the model keeps one full array copy per published version and
  every historical snapshot is verified point-by-point against its copy
  (401 versions × 96 points, deterministic seed).
- `test_lifetime` — **poisoning allocator** (reclaimed node storage is
  overwritten with `0xCD` and deliberately not unmapped) plus
  `std::barrier`-synchronized interleavings: readers query old snapshots
  exactly while the writer publishes batches that reclaim previous
  versions; also a 1-writer / 4-reader consistency soak, and an
  alloc/dealloc balance check (no leak, no double free).

Sanitizer builds:

```sh
cmake -S . -B build-asan -DIX_SANITIZER=address,undefined
cmake -S . -B build-tsan -DIX_SANITIZER=thread
```

See `RESULTS.md` for the recorded test results.
