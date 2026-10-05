# CTest 实际运行结果

- 日期: 2026-10-05 11:44:36 CST
- 编译器: g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0
- CMake: cmake version 4.2.3
- 构建: Release, C++20 (extensions off), -Wall -Wextra 无警告

```
1: test_rational: OK
1/5 Test #1: rational .........................   Passed    0.01 sec
2: test_ray_aabb: OK
2/5 Test #2: ray_aabb .........................   Passed    0.01 sec
3: test_tree_vs_scan: OK (2400 rays, 990 total hits)
3/5 Test #3: tree_vs_scan .....................   Passed    0.04 sec
4: test_snapshot: OK
4/5 Test #4: snapshot .........................   Passed    0.01 sec
5: test_concurrency: OK (3670 snapshot validations, 0 errors)
5/5 Test #5: concurrency ......................   Passed    0.02 sec
100% tests passed, 0 tests failed out of 5
Total Test time (real) =   0.09 sec
```
