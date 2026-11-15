# Arrow union 切片偏移重写

内存数据管线要嵌入可嵌入的 C++ Arrow dense/sparse union 切片库，联合 type id、child offset、父 offset 和有效长度生成零拷贝视图或安全重写。dense 子偏移越界立即失败；嵌套切片组合与一次切片等价，未引用 child 不得被误纳入。

## 设计

`dataeng` 是零外部依赖、可直接嵌入的 C++20 静态库，按 Arrow union 的缓冲区级布局建模
（type id 缓冲、dense value offset 缓冲、父 offset/length、child 数组），不依赖 Arrow 运行时。

- `ArrayNode` 同时描述叶子数组与 union 数组；缓冲区默认以裸指针借用，仅安全重写路径通过
  `owned_*` 的 `shared_ptr` 持有新分配内存。
- `Slice(array, offset, length, strategy)` 联合四个输入：type id、child offset、父
  offset、有效长度，返回 `SliceResult{status, array}`，无异常、无隐式终止。

### 两种策略

- `SliceStrategy::ZeroCopy`（`ZeroCopySlice`）：不复制任何 union 缓冲，仅调整父 offset，
  并按切片行实际引用的 type code 保留 child；嵌套 union 的 child 缓冲同样原样共享。
- `SliceStrategy::SafeRewrite`（`RewriteSlice`）：生成自包含的紧凑表示——父 offset 归零、
  复制 type id；dense 模式下按每个 type code 的最小引用位置压缩 child 窗口并将 value
  offset 重定基到零；sparse 模式下对每个被引用 child 递归同范围切片。

### 保证的语义

- **越界立即失败**：两条策略都会逐行校验。dense value offset 为负或超出 child 物理长度时
  返回 `SliceError::DenseOffsetOutOfBounds`，零拷贝路径也不会延迟或静默别名。
- **嵌套切片等价**：对切片结果再次切片，与在原数组上一次切片逻辑等价
  （`LogicalEquals` 按解析后的实际值比较，兼容绝对/重定基 offset）。
- **未引用 child 不纳入**：两条策略都只保留切片行实际出现的 type code 对应 child，
  保持首次引用顺序。
- 父范围非法返回 `ParentOutOfBounds`，未知 type id 返回 `InvalidTypeId`，
  布局不一致返回 `InvalidLayout`；空切片（length 为 0）合法且不带任何 child。

## 构建与测试

```bash
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## 最小示例

```cpp
#include "dataeng.hpp"
using namespace dataeng;

const std::int8_t  ids[]     = {1, 0, 1};
const std::int32_t offsets[] = {0, 0, 1};
ArrayNode root = MakeUnion(
    UnionMode::Dense, 3, ids, offsets,
    std::vector<std::int8_t>{0, 1},
    std::vector<ArrayNode>{
        MakeLeaf(child0.data(), sizeof(std::int32_t), child0.size()),
        MakeLeaf(child1.data(), sizeof(std::int64_t), child1.size())});

SliceResult view     = ZeroCopySlice(root, 1, 2);  // 共享缓冲
SliceResult compact  = RewriteSlice(root, 1, 2);  // 重定基、自包含
if (!compact.status.ok()) { /* compact.status.code */ }
```
