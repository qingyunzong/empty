# spatial-index

并发空间索引库（C++20，仅标准库），提供半开 AABB 语义、原子批次发布、
快照隔离与屏障回收。

## 语义

- **半开 AABB**：盒子为 `[min, max)`。边界相触（`max == other.min`）不相交，
  角点相触也不相交。
- **零体积忽略**：任一轴上 `min >= max` 的盒子为空。空盒子的插入/移动被忽略
  （已有对象保持原位），空查询盒不命中任何对象。
- **批次移动原子**：`SpatialIndex::apply(Batch)` 先在写锁内构建完整新快照，
  再以单次原子 store 发布；读者只会看到全部旧位置或全部新位置。
- **旧快照合法**：`snapshot()` 返回 `shared_ptr<const Snapshot>`，不可变且
  自包含；之后的删除、移动、ID 复用都不影响已持有的旧视图。
- **屏障回收**：被替换的快照进入 `Reclaimer` 退休列表；`reclaim_barrier()`
  须在所有线程都通过静止点（如 `std::barrier` 会合）后调用，它只释放回收器
  自己的引用——仍被读者持有的快照继续存活。

## 结构

- `include/spatial/aabb.hpp` — 半开 AABB 与相交判定
- `include/spatial/snapshot.hpp` — 不可变快照：均匀网格哈希索引 + 精确半开过滤
- `include/spatial/index.hpp` — `SpatialIndex` / `Batch`，原子发布
- `include/spatial/reclaimer.hpp` — 屏障回收器
- `tests/` — CTest 测试（自带极简 CHECK 框架，无第三方依赖）

## 构建与测试

```sh
cmake -S . -B build
cmake --build build -j
cd build && ctest --output-on-failure
```

## 测试

- `test_aabb` — 半开相交语义：重叠/包含相交，边与角相触不相交，零体积为空
- `test_index` — 查询与零体积处理；删除与 ID 复用下的旧快照隔离；
  4 读者 + 1 写者 × 2000 次批次翻转的原子可见性（混合位置即违例）
- `test_reclaimer` — 退休快照在屏障前存活、`std::barrier` 会合后回收；
  持有引用的读者跨过屏障仍可读，最后引用释放后真正销毁
- `test_model_check` — 400 轮随机增删改（含 ID 复用、零体积操作）后，
  每轮 20 个随机/对齐查询与暴力全扫描模型逐一比对

## 实际测试结果（g++ 15.2.0, cmake 4.2.3, x86-64 Linux）

常规构建（`-Wall -Wextra -Wpedantic`，零告警）：

```
1/4 Test #1: test_aabb ........................   Passed    0.00 sec
2/4 Test #2: test_index .......................   Passed    0.04 sec
3/4 Test #3: test_reclaimer ...................   Passed    0.00 sec
4/4 Test #4: test_model_check .................   Passed    0.02 sec
100% tests passed, 0 tests failed out of 4
```

- 常规构建连续 200 轮 `ctest`：全部通过。
- ThreadSanitizer 构建（`-fsanitize=thread`）连续 5 轮：全部通过，无数据竞争。
- ASan+UBSan 构建（`-fsanitize=address,undefined`，`detect_leaks=0`）：
  全部通过。（本环境 ptrace 受限，LeakSanitizer 无法运行，故关闭泄漏检测。）
