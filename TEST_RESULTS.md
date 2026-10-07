# Test Results (actual run)

- Date: 2026-10-07 (Asia/Shanghai)
- Toolchain: g++ 15.2.0 (Ubuntu), CMake 4.2.3, CTest 4.2.3
- Standard: C++20 (`-std=c++20`, no extensions), flags `-Wall -Wextra -Wpedantic -Werror`
- Build: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build` — clean, zero warnings
- Command: `cd build && ctest --output-on-failure -V`

## CTest summary

```
1/4 Test #1: test_viewport ....................   Passed    0.00 sec
2/4 Test #2: test_cache .......................   Passed    0.00 sec
3/4 Test #3: test_loader ......................   Passed    0.00 sec
4/4 Test #4: test_conservation ................   Passed    0.00 sec
100% tests passed, 0 tests failed out of 4
```

## Per-test check counts (from test binaries' own reports)

| Test | Checks | Failures | Covers |
|---|---|---|---|
| test_viewport | 13 | 0 | TileId ancestry math; coarse-to-fine hierarchical request set |
| test_cache | 37 | 0 | LRU eviction to budget; oversized reject; late results confined to same-version pool; parent substitution flagged approximate; eviction callback |
| test_loader | 34 | 0 | Viewport-driven queueing; on-demand pump; byte-neutral cancellation; dropped late reply after cancel; in-flight old-generation requests land in stale pool; loader acknowledges evictions; substitution through loader |
| test_conservation | 68 | 0 | 60-step mixed workload (viewport jumps, partial pumps, cancels, late deliveries, evictions, rejections); conservation invariant `admitted == live + evicted` checked after every step; evidence log reconciles exactly with byte counters |

## Sanitizer re-run

- Build: `cmake -S . -B build-asan -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer"`
- Result: `100% tests passed, 0 tests failed out of 4` (run with `ASAN_OPTIONS=detect_leaks=0`;
  LeakSanitizer itself cannot start under this container's ptrace restrictions — an
  environment limitation, not a test failure; all test binaries report PASS with 0 failures).
