# graph-adjacency-intersection

C++20 图库组件：对多个邻接集合做**流式交集**，保留边来源，输出唯一节点。

## 设计

- **游标拉取**：输入经 `AdjacencyCursor::next()` 逐条拉取（要求节点 ID 非递减），
  大列表从不整体载入内存。
- **k 路归并交集**：任一游标耗尽即终止；最小头小于最大头时跳过最小侧。
- **去重与来源合并**：同一集合内重复节点被合并，输出的每个 `IntersectionHit`
  节点唯一，并携带所有输入集合贡献的、排序去重后的 `SourceId` 列表。
- **驻留 ID 内存预算**：`MemoryBudget::max_resident_ids` 限制同时驻留的输入 ID
  （游标头 + 1 个装配中的候选），最小需求为 `游标数 + 1`；超限返回
  `kBudgetExceeded`。结果中的 `peak_resident_ids` 可用于审计。
- **原子发布**：结果在内部私有累积，仅在全部成功时返回；任一游标报错
  （`kCursorFailure`）或输入乱序（`kUnsortedInput`）时不会暴露任何部分结果。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试包含：基本交集、重复去重、游标错误不发布、预算超限、大输入驻留 ID 上限
（20 万节点 × 4 集合，峰值 ≤ 游标数 + 1）、乱序检测、空/单集合边界，
以及与 `std::set` 参考实现对比的 300 轮随机模糊测试。
