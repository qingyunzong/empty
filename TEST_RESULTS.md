# 实际测试结果记录

- 日期: 2026-10-06
- 编译器: g++ 15.2.0 (Ubuntu), C++20, -Wall -Wextra -Wpedantic, Release
- 工具: CMake 4.2.3 / CTest 4.2.3
- 命令: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j && cd build && ctest -V`
- 结果: **7/7 全部通过, 0 失败**

## 各测试实际输出

```
[quantize] 18 cases checked
[identity] 500 samples, out==in: yes
[chunk] rate=3/2 outputs=1557 checksum=5959565895624343526 all 7 chunkings identical
[chunk] rate=2/3 outputs=687 checksum=17361218614946378932 all 7 chunkings identical
[chunk] rate=1/4 outputs=252 checksum=3555165965718977980 all 7 chunkings identical
[chunk] rate=4/1 outputs=4168 checksum=9181217459282374587 all 7 chunkings identical
[chunk] rate=5/7 outputs=746 checksum=7390644574630206809 all 7 chunkings identical
[chunk] rate=7/5 outputs=1466 checksum=1173901895713654630 all 7 chunkings identical
[chunk] rate=1/1 outputs=1007 checksum=6709074136924627476 all 7 chunkings identical
[zero_tail] counts z=0:440 z=5:447 z=40:500 prefix+reference ok
[impulse] peak at output 3 amplitude 4000 total outputs 366 identical across chunkings
[saturation] 40000->32767, -40000->-32768, boundary 16384*-2=-32768 ok
[guards] process-after-finish, double-finish, invalid-args all throw
```

## CTest 汇总

```
100% tests passed, 0 tests failed out of 7
```

## 关键实测数据说明

- `chunk_invariance`: 输入 1000 样本 + 53 零填尾, 7 种采样率比(3/2, 2/3, 1/4, 4/1, 5/7, 7/5, 1/1),
  每种比率下 7 种切块(1, 2, 3, 7, 31, 128, 1000)与一次性输入的输出逐样本一致(FNV 校验和相同),
  且与独立直写参考实现一致, 输出总数符合闭式公式。
- `impulse_delay`: 49 抽头线性相位 FIR, 3/2 比率, 冲激位于输入 10,
  峰值稳定出现在输出 3(理论推导一致), 幅度 4000, 跨全部切块相同 —— 延迟不随切块变化。
- `zero_tail`: zeroPad=0/5/40 时输出数 440/447/500, 满足前缀性质, 尾部零个数严格由 finish 参数决定。
