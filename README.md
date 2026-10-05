# interval_index — 单写多读区间索引库

C++20 标准库实现，头文件唯一依赖（`include/interval_index.hpp`）。

## 设计

- **不可变 treap**：不相交、已合并的半开区间段 `[lo, hi) -> Val`，所有更新走
  路径复制（persistent），旧版本的节点永不被修改。
- **原子发布根**：根为 `std::atomic<std::shared_ptr<const node>>`。写线程把整批
  操作构建成新根后一次 `store` 发布；读者 `get_snapshot()` 原子加载，要么看到
  整个旧批次、要么看到整个新批次，绝无撕裂。
- **节点回收**：`shared_ptr` 引用计数。被替换的节点只有在当前根和所有读者
  快照都不再引用时才销毁——旧快照查询不受回收影响，无需 hazard pointer。
- **单写多读**：写路径一把互斥锁（防误用），读路径无锁。

## 组合顺序（明确语义）

- 一个批次内的操作**按提交顺序**依次应用，整批原子发布。
- `assign [l,r) v`：覆盖区间内一切（包括先前的 add 结果）。
- `add [l,r) d`：累加到当前值；缺失区间按 `Val{}`（零）处理，因此 add 会在
  空洞上物化新段。
- `erase [l,r)`：移除覆盖。
- 例：同一批次 `{add [0,10) +5, assign [3,7) 100}` → `[3,7)=100`；
  换序 `{assign [3,7) 100, add [0,10) +5}` → `[3,7)=105`。
- 规范形：相邻段值必不相等（自动合并），模型可精确比对段列表。

## 测试（CTest）

| 测试 | 内容 |
|---|---|
| `semantics` | assign/add/erase 语义、组合顺序两序各验、边界切分、负键、规范形合并 |
| `model` | 小数组复制模型核对：30 轮 × 120 批随机操作，每批后与 `array<optional<int64>,64>` 模型逐点比对并精确比对段列表 |
| `lifetime` | 毒化释放器（析构后 0xDD 填充再释放，创建/销毁精确计数）验证节点只在无引用时回收；`std::barrier` 保证写线程发布 300 个新版本后读者再查旧快照，结果必须仍是旧版本；3 读者 + 1 写者 2000 批并发压力测试 |

## 构建与运行

```sh
cmake -S . -B build && cmake --build build -j
ctest --test-dir build --output-on-failure
# 可选：ASan+UBSan（沙箱中需 ASAN_OPTIONS=detect_leaks=0）
cmake -S . -B build-asan -DINTERVAL_INDEX_SANITIZERS=ON && cmake --build build-asan -j
ASAN_OPTIONS=detect_leaks=0 ctest --test-dir build-asan --output-on-failure
```

## 实际测试结果（2026-10-06, GCC 15.2.0, CMake 4.2.3）

普通构建（`-O2 -Wall -Wextra -Wpedantic`，零警告）：

```
1/3 Test #1: semantics ........................   Passed    0.01 sec
2/3 Test #2: model ............................   Passed    0.11 sec
3/3 Test #3: lifetime .........................   Passed    0.38 sec
100% tests passed, 0 tests failed out of 3
```

ASan+UBSan 构建（`detect_leaks=0`，沙箱 ptrace 限制）：

```
1/3 Test #1: semantics ........................   Passed    0.04 sec
2/3 Test #2: model ............................   Passed    1.61 sec
3/3 Test #3: lifetime .........................   Passed    3.09 sec
100% tests passed, 0 tests failed out of 3
```
