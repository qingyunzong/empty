# CTest 实际运行结果

环境：g++ 15.2.0 (Ubuntu), CMake 4.2.3, C++20, Debug 构建。

命令：`cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure`

## 汇总

```
    Start 3: shutdown
3/4 Test #3: shutdown .........................   Passed    0.01 sec
    Start 4: frame_stats
4/4 Test #4: frame_stats ......................   Passed    0.01 sec

100% tests passed, 0 tests failed out of 4

Total Test time (real) =   0.03 sec
```

## 各测试输出（每 frame 释放统计）

```
1:   scenario complete_first=1: resumed=1 outcome=1 releases/frame: [f2]=1
1:   scenario complete_first=0: resumed=1 outcome=0 releases/frame: [f2]=1
1: test_completion: OK
2:   frame 0: 1 release(s)
2: test_destroy: OK
3:   frame 2: 4 release(s)
3: test_shutdown: OK
    Start 4: frame_stats
4: Test command: /home/delin/.local/share/gsb-workbench/artifacts/9fb7e2a0d07d406aa6237d942df16d53/run/A/attempt-001/workspace/build/test_frame_stats
4:   frame 0: resumed 3
4:   frame 1: resumed 1
4:   frame 2: resumed 2
4:   releases in frame 2: 3
4: test_frame_stats: OK
4/4 Test #4: frame_stats ......................   Passed    0.00 sec
```
