# Test Results

Recorded on 2026-10-05 05:14:17 CST with g++ 15, CMake 4.2.3.

## Normal build (`-DCMAKE_BUILD_TYPE=Debug`)

```
Test project /home/delin/.local/share/gsb-workbench/artifacts/cfb90e761c054920877435d9ce1c9739/run/B/attempt-001/workspace/build
    Start 1: test_diagnostics
1/4 Test #1: test_diagnostics .................   Passed    0.00 sec
    Start 2: test_normals
2/4 Test #2: test_normals .....................   Passed    0.00 sec
    Start 3: test_incremental
3/4 Test #3: test_incremental .................   Passed    0.00 sec
    Start 4: test_snapshot
4/4 Test #4: test_snapshot ....................   Passed    0.00 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.01 sec
```

## Sanitizer build (`-DINTMESH_SANITIZE=ON`, ASan+UBSan)

LeakSanitizer is disabled (`ASAN_OPTIONS=detect_leaks=0`) because it cannot run under this sandbox's ptrace restrictions.

```
Test project /home/delin/.local/share/gsb-workbench/artifacts/cfb90e761c054920877435d9ce1c9739/run/B/attempt-001/workspace/build-san
    Start 1: test_diagnostics
1/4 Test #1: test_diagnostics .................   Passed    0.01 sec
    Start 2: test_normals
2/4 Test #2: test_normals .....................   Passed    0.01 sec
    Start 3: test_incremental
3/4 Test #3: test_incremental .................   Passed    0.01 sec
    Start 4: test_snapshot
4/4 Test #4: test_snapshot ....................   Passed    0.01 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.03 sec
```
