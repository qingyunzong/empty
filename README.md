# tilelib — viewport-hierarchical tile cache & controllable loader (C++20)

Header-only C++20 library, standard library only. Build and test:

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```

## Design

- **Viewport-hierarchical requests** — `required_tiles(Viewport)` expands a
  viewport into tiles coarse-to-fine across `[min_level, level]`
  (`include/tilelib/viewport.hpp`). `TileLoader::set_viewport` queues exactly
  the missing tiles.
- **Versioned generations** — every tile is stamped with the viewport
  generation that requested it. The cache keeps two pools: a *current* pool
  (the new viewport's required capacity) and a *stale* pool (same-version
  cache) with its own smaller budget. Late results from an old viewport keep
  their original generation stamp and are confined to the stale pool — they
  never occupy the new viewport's required capacity
  (`TileCache::insert`, `include/tilelib/cache.hpp`).
- **Parent substitution, precision-flagged** — `TileCache::render_set`
  resolves each wanted tile to an exact hit or to its nearest cached ancestor.
  Substituted slots carry `approximate = true` and
  `source = Source::ParentSubstitute`, i.e. explicitly marked as
  precision-deficient.
- **Controllable loader** — `TileLoader` completes requests only when the
  caller pumps (`pump`) or injects a late arrival (`deliver_late`).
  `cancel(id)` drops a queued request (byte-neutral). Cache evictions are
  pushed back to the loader through a callback, which acknowledges and logs
  them (`include/tilelib/loader.hpp`).
- **Source evidence & byte-budget conservation** — every admit / evict /
  cancel / late-admit / reject is appended to an evidence log with tile id,
  generation and byte count. `CacheStats::conserved()` asserts the invariant
  `admitted_bytes == current_bytes + stale_bytes + evicted_bytes`;
  `test_conservation` verifies it after every step of a 60-step mixed
  workload and reconciles the evidence log byte-for-byte against the counters.

## Layout

- `include/tilelib/tile.hpp` — `TileId`, `Source`, `Tile`, `Evidence`
- `include/tilelib/viewport.hpp` — `Viewport`, `required_tiles`
- `include/tilelib/cache.hpp` — `TileCache`, `CacheStats`
- `include/tilelib/loader.hpp` — `TileLoader`
- `tests/` — CTest executables (see `TEST_RESULTS.md` for actual results)
