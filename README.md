# binidx — 64 位二进制索引库与检查工具

C++20 标准库实现的二进制索引解析/校验库，配套检查 CLI、极值与截断
夹具生成器，以及与任意精度（Python 大整数）区间检查器的交叉对照测试。

## 格式（BINIDX01，小端）

| 偏移 | 内容 |
|---|---|
| 0  | u64 magic `"BINIDX01"` |
| 8  | u64 条目数 count |
| 16 | count × { u64 offset, u64 length } |

## 规则

- **防溢出边界计算**：段的独占端点 `end = offset + length` 必须能用 64 位
  表示；`length > UINT64_MAX - offset` 即判 `SEGMENT_OVERFLOW`，绝不回绕。
- **可共享、不可部分重叠**：完全相同的区间视为共享（允许）；任何非空区间
  相交但不相同即判 `PARTIAL_OVERLAP`。零长段是空区间，不与任何东西重叠。
- **只读视图不越界**：`make_view` 仅当段完全落在 `[0, file_size)` 内才成功；
  `View::at` 带边界检查并抛 `std::out_of_range`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
cd build && ctest --output-on-failure
```

## 组件

- `binidx`（库）：`include/binidx/binidx.hpp` + `src/binidx.cpp`
- `idxcheck`（CLI）：`idxcheck <index> [--data <file>]`，末行输出
  `RESULT: OK` 或 `RESULT: INVALID <CODE>: <msg>`；退出码 0/1/2
- `idxgen`（夹具生成器）：`idxgen emit <dir>` 生成极值与截断用例
- `tests/oracle.py`：任意精度参考检查器（Python 大整数，无回绕）
- `tests/crosscheck.py`：逐用例比对 idxcheck 与 oracle 的判定和退出码

实际测试结果见 [RESULTS.md](RESULTS.md)。
