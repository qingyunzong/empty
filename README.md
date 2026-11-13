# Windows Event Log bookmark 协调层

`dataeng` 是一个不依赖 Windows API 的 C++20 库，用于把审计采集代理嵌入
Event Log 的 bookmark 协调逻辑。它为每个 channel 维护一个可持久化的
bookmark，并解决日志清除、channel 重建以及订阅回调与补拉查询交错时的
记录丢失、重复和乱序问题。

## 语义

- Bookmark 绑定 `(channel, record id, provider, query version, generation)`。
  任意一项不匹配都不会推进游标。
- `on_log_cleared()` / `on_channel_rebuilt()` 开启新世代。旧世代的 bookmark
  返回 `generation_mismatch`，`resume_after` 为空，因此调用方从新世代的
  起点开始查询，不会用旧 record id 跳过新记录。
- 严格合并模式（默认）先执行补拉并设置 watermark。watermark 以下已经
  取完，订阅先到的较大 record id 会暂存；补拉补齐后按 record id 升序交付。
- 同一个 `(generation, record id)` 只交付一次，无论它先来自订阅还是补拉。
- 世代切换前会先把旧世代已缓存的记录按 record id 冲刷出去，避免清日志时
  丢失已经收到的审计事件。
- 进程重启时把持久化的世代传给
  `CoordinatorOptions::initial_generation`，bookmark 才能和 channel 当前
  世代正确对上。

## 用法

```cpp
#include "dataeng.hpp"

dataeng::BookmarkCoordinator coordinator({
    .channel = "Security",
    .provider = "Microsoft-Windows-Security-Auditing",
    .query_version = "security-v3",
});

// 从已经持久化的 bookmark 恢复。旧世代 bookmark 不会被接受。
if (auto restored = coordinator.restore_bookmark(saved_bookmark);
    !restored.accepted()) {
    // generation/query/provider 已变化，从当前世代起点重新查询。
}

// 先声明补拉范围，再同时接入订阅回调和补拉页。
coordinator.begin_backfill(0);
auto from_backfill = coordinator.ingest_backfill(page_of_records);
auto from_subscription = coordinator.ingest_subscription(live_record);

for (const auto& delivered : from_backfill.ready) {
    consume(delivered.record, delivered.generation);
}
for (const auto& delivered : from_subscription.ready) {
    consume(delivered.record, delivered.generation);
}

// 补拉追平后切换为实时交付。
for (const auto& delivered : coordinator.complete_backfill()) {
    consume(delivered.record, delivered.generation);
}

// 持久化“最后交付”的位置，而不是最后收到的位置。
auto bookmark = coordinator.snapshot_bookmark().serialize();
```

没有补拉查询、只需要订阅时，可以构造
`CoordinatorOptions{.strict_merge = false}`，或者启动后调用一次
`complete_backfill()`。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
