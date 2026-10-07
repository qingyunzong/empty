# graph_intersect

C++20 图库：对多个邻接集合做**流式交集**，保留每条边的来源，结果唯一。

## 设计

- **游标接口**（`include/gs/cursor.hpp`）：`NodeCursor` concept 约定 `next()`
  返回 `Expected<std::optional<NodeId>>` —— 值 / 结束（`nullopt`）/ 错误。
  输入必须非降序，允许重复。`Cursor` 为类型擦除包装，便于异构游标收集。
- **交集算法**（`include/gs/intersect.hpp`）：k 路归并，每个游标任意时刻
  只驻留一个当前 ID（k 个输入 = k 个驻留 ID），绝不一次性读入整个列表。
  集合内重复自动去重，结果节点唯一且升序；每个结果节点附带
  `sources`（每个输入集合贡献的边：`list_index / from / to`）。
- **内存预算**：`MemoryBudget` 按驻留 ID 计数；预算小于输入个数时返回
  `BudgetExceeded`，成功路径可用 `max_resident()` 核验驻留上限。
- **错误语义**：任一游标报错（含违反有序契约）即整体失败，返回 `Error`，
  不发布任何最终结果；预算槽位由 RAII 保证释放。
- **图封装**（`include/gs/graph.hpp`）：`Graph::common_neighbors(nodes, budget)`
  通过索引游标直接在存储的邻接表上流式求交，不复制列表。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试（`tests/test_intersect.cpp`，8 个 CTest 用例）：

- `basic`：含重复节点的交集，结果唯一且来源完整
- `randomized_vs_reference`：500 组随机输入与 `std::set_intersection` 参考核验
- `cursor_error` / `unsorted_input`：游标报错/乱序 → 返回错误、不发布结果
- `memory_budget`：预算不足报错；恰好 k 槽位成功且驻留不超限
- `lazy_streaming`：懒生成游标（不物化列表）求交
- `edge_cases` / `graph_integration`：空集/单集/不相交、Graph 集成
