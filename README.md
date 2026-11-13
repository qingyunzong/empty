# 流式 Top-K 撤回语义

排名服务需要可嵌入 C++ changelog Top-K 算子，接收 insert/update_before/update_after/delete，按分组、分数和稳定并列键维护前 K。每次变更只输出必要 retract/insert，键更组视为跨组事务；恢复快照后输出序列与不中断执行相同。

## API 概览（`dataeng.hpp`）

- `TopKOperator(size_t k)`：构造算子，K 对所有分组生效。
- `apply(Event)` / `insert` / `updateBefore` / `updateAfter` / `erase`：应用一条变更，返回本次产生的 `Change` 序列（`Retract` 或 `Insert`）。
- `snapshot()` / `restore(snapshot)`：状态深拷贝与恢复；恢复后重放同一事件流，输出序列与不中断执行完全一致。
- `topK(group)`：查看某分组当前前 K（按名次排序）。

## 语义约定

- 排名：分数降序，同分按键升序（稳定并列键），每组取前 K。
- 最小输出：每次变更只对受影响分组的 Top-K 成员资格/行内容变化输出差集；组内先 retract 后 insert。
- `update_before` 只锁存前像、不产生输出；`update_after` 原子完成迁移并输出差集。键更组作为跨组事务：先输出旧组差集（retract + 可能的晋升 insert），再输出新组差集（可能的挤出 retract + insert）。
- 严格校验：重复 insert、未知键的 update/delete、与跟踪状态不符的负载、NaN 分数均抛 `std::invalid_argument`，且算子状态保持不变。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
