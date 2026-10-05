# xreduce — 确定性并行归约库（C++20）

对**精确有理数**（`Rational`，基于任意精度 `BigInt`）或**精确整数**做并行归约。
仅依赖 C++20 标准库，头文件库，无需链接。

## 设计

- **固定分块树**：下标区间 `[0, n)` 按固定 `block_size` 分块；每块在线程内按下标顺序
  串行折叠为一个部分和；部分和按固定的逐层相邻配对二叉树合并。合并顺序只取决于
  树的形状，与线程调度/完成顺序无关，因此**线程完成顺序不影响结果**。
- **取消**：`CancelToken::cancel()` 后，归约返回无值（`value == nullopt`，
  `cancelled == true`），并在返回前**释放全部部分和缓冲**（`BufferTracker` 可观测，
  返回后 `live() == 0`）。
- **块失败**：`map(i)` 返回 `nullopt` 即标记所在块失败；并发失败时以原子取最小，
  报告**最小失败块号**（`failed_block`），不返回值。
- **屏障乱序**：内部使用可复用 `PhaseBarrier`（`include/xreduce/barrier.hpp`），
  各层归约之间所有线程以任意顺序到达；最后一次到达执行层间完成回调
  （缓冲交换/推进层号）再放行。测试以随机抖动打乱到达顺序，与**串行树模型**
  `serial_tree_reduce` 逐位核对。

## API 摘要（`include/xreduce/reduce.hpp`）

```cpp
template <typename T, typename Map, typename Combine>
ReduceOutcome<T> parallel_reduce(std::size_t n, Map map, Combine combine,
                                 ReduceOptions opts = {},
                                 CancelToken *token = nullptr,
                                 BufferTracker *tracker = nullptr);

template <typename T, typename Map, typename Combine>
std::optional<T> serial_tree_reduce(std::size_t n, Map map, Combine combine,
                                    std::size_t block_size); // 串行参照模型
```

`ReduceOutcome<T>`：`value`（取消/失败时为空）、`failed_block`（最小失败块号）、
`cancelled`。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
cd build && ctest --output-on-failure
```

CTest 用例：

| 测试 | 内容 |
| --- | --- |
| `test_bigint` | 任意精度整数四则/整除/gcd/十进制输出恒等式 |
| `test_rational` | 有理数规范化、精确调和数 H_20/H_50 |
| `test_determinism` | 5 种块大小 × 6 种线程数，并行结果 == 串行树模型，整数和与 __int128 交叉验证 |
| `test_cancel` | 运行前/运行中取消：无值返回且缓冲全部释放 |
| `test_failure` | 多块并发失败报告最小块号（50 次重复） |
| `test_barrier` | 原始屏障 300 相位乱序到达 + 30 轮随机抖动归约对串行模型核对 |
| `record_results` | 把实际计算结果写入 `actual_results.txt` 并自校验 |

实际运行结果见仓库根目录 `actual_results.txt`（H_100 精确值、2^200−1、
50 轮乱序试验 0 失配、失败块号、取消后存活缓冲数 0 等）。
