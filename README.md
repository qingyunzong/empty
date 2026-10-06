# detreduce — deterministic parallel tree reduction (C++20)

Header-only library for parallel reduction over **exact** values
(arbitrary-precision integers `bigint` and rationals `rational`, or any
user type) with a **fixed chunk tree**: the result depends only on the
input and the chunk size, never on thread scheduling.

## Semantics

- **Fixed chunk tree.** Indices `[0, n)` are split into chunks of
  `chunk_size`. Each chunk is left-folded; chunk partials are combined
  pairwise left-to-right, level by level (odd leftover carried up).
  `tree_reduce` (parallel) and `serial_tree_reduce` (serial reference
  model) implement the *same* tree, so results are bit-for-bit identical
  regardless of thread completion or barrier arrival order.
- **Cancellation.** Request via `cancel_token::request()`. The outcome is
  `reduce_status::cancelled` with no value, and all internal buffers are
  released before `tree_reduce` returns (observable via
  `reduce_stats::live_buffers == 0`).
- **Failure.** If `map` throws, the failing chunk is recorded and other
  workers stop picking up new chunks. The outcome is
  `reduce_status::failed` and `error->chunk` is the **smallest** failing
  chunk index. Failure takes precedence over cancellation.
- **Barriers.** Two `std::barrier` phases per tree level publish a
  uniform stop decision and advance the level exactly once per phase
  (in the barrier completion step), so all workers observe identical
  level structure even when they arrive out of order.

## API

```cpp
#include <detreduce/reduce.hpp>

detreduce::reduce_options opts;
opts.chunk_size = 128;
opts.workers = 8;             // 0 => hardware_concurrency
opts.token = &token;          // optional
opts.stats = &stats;          // optional instrumentation

auto out = detreduce::tree_reduce<detreduce::rational>(
    n,
    [](std::size_t i) { return detreduce::rational(1, (long long)i + 1); },
    [](const detreduce::rational& a, const detreduce::rational& b) { return a + b; },
    opts);
// out.status, out.value, out.error
```

`map` may throw (chunk failure); `combine` must not throw. `T` must be
default-constructible (empty input reduces to `T{}`).

## Build & test

```sh
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

See `RESULTS.md` for the recorded test run.
