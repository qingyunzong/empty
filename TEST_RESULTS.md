# 测试实际结果记录

- 日期: 2026-10-05 04:34:09 CST
- 工具链: g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0, cmake version 4.2.3
- 命令: `ctest --test-dir build --output-on-failure`

```
Test project /home/delin/.local/share/gsb-workbench/artifacts/b86daf711c9e4d6c95aed7ac81bc00e0/run/B/attempt-001/workspace/build
    Start 1: unit
1/4 Test #1: unit .............................   Passed    0.00 sec
    Start 2: cli_cycle
2/4 Test #2: cli_cycle ........................   Passed    0.00 sec
    Start 3: cli_weak_order
3/4 Test #3: cli_weak_order ...................   Passed    0.00 sec
    Start 4: cli_strong_conflict
4/4 Test #4: cli_strong_conflict ..............   Passed    0.00 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.02 sec
```
