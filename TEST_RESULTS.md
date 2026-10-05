# 测试结果记录

环境：GCC 15.2.0 (Ubuntu)，CMake 4.2.3，x86-64 Linux，C++20。

## Debug 构建（`-Wall -Wextra -Wpedantic`，零告警）

```
$ cmake -S . -B build && cmake --build build -j && cd build && ctest
1/6 Test #1: test_filters ......................   Passed    0.00 sec
2/6 Test #2: test_chunking .....................   Passed    0.00 sec
3/6 Test #3: test_crc ..........................   Passed    0.00 sec
4/6 Test #4: test_ihdr .........................   Passed    0.00 sec
5/6 Test #5: test_overflow .....................   Passed    0.01 sec
6/6 Test #6: test_stream .......................   Passed    0.00 sec

100% tests passed, 0 tests failed out of 6
```

## Sanitizer 构建（ASan + UBSan）

```
$ cmake -S . -B build-san -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer"
$ cmake --build build-san -j && cd build-san && ASAN_OPTIONS=detect_leaks=0 ctest
100% tests passed, 0 tests failed out of 6
```

（本沙箱 ptrace 受限，LeakSanitizer 无法运行，故关闭泄漏检测；ASan/UBSan 本身无报告。）

## 覆盖要点

- `test_filters`：五种滤波各自 + 逐行混合滤波，随机/全 0/全 0xFF、单行/单列/单像素图；
  测试内独立实现的前向滤波与逆滤波交叉核对解码结果；验证多 IDAT 拼接顺序与期望裸尺寸。
- `test_chunking`：同一 PNG 按 1/2/3/7/8/13/64 字节、不规则及随机切分喂入，结果与一次喂入一致；
  空 feed 无害。
- `test_crc`：篡改 IHDR/IDAT/IEND 的 CRC 字段、IHDR/IDAT 载荷、块类型字节，均以
  `CrcMismatch` 拒绝且无图像发布。
- `test_ihdr`：IHDR 非首块/缺失/重复、长度非 13、零宽高（`InvalidIhdr`/`MissingIhdr`/
  `UnexpectedChunk`）；16 位、真彩、调色板、RGBA、Adam7 交错、未知压缩/滤波方法
  （`UnsupportedFormat`）。
- `test_overflow`：0xFFFFFFFF 等巨宽高超派生尺寸上限、单块声明长度 0xFFFFFFFF、
  IDAT 总量超限（`LengthOverflow`）；inflate 产物尺寸不符（`SizeMismatch`）、
  inflate 失败（`InflateFailed`）；边界值恰好等于上限时正常接受。
- `test_stream`：坏签名；对每个前缀长度截断均 `Truncated`；未知关键块拒绝、未知辅助块跳过；
  非连续 IDAT 拒绝；IEND 后尾随字节 `TrailingData`；非法滤波字节 `BadFilter`；
  IEND 载荷非空拒绝；IEND 前图像不可观测；失败后 `takeImage()` 一律为空（不发布部分图）。
