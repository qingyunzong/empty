# eBPF ring buffer 丢失记账与全局事件流

`dataeng` 将每个 CPU 的 ring buffer 消费状态归并成一条全局事件流。输入记录只需要携带
`cpu`、`sequence`、累计 `lost` 计数器、`timestamp` 和 `schema_version`，其余字段可留给
现有消费状态库使用。

## 核心行为

- 每个 CPU 独立维护 sequence 基线、累计 lost 计数器、最后时间戳和 schema version。
- 同一世代内 `sequence` 出现缺口时，立即产生显式 `Loss` 事件，记录缺失区间
  `[first_sequence, last_sequence]`、`missing_count` 和该时刻的 `lost_delta`。
- 已经声明为缺失的 sequence 不会被后续迟到记录回填。迟到记录计入
  `rejected_backfill`，原有 loss 事件保持不变。
- `CPU offline/online` 会开启新的局部世代，sequence 与 lost 基线同时重置，因此热插拔
  不会产生虚假的 loss。
- sequence 回退且时间戳不早于上一条记录时，也可按隐式世代切换处理。
- 全局事件流按 `(timestamp, cpu, generation, sequence, loss-before-record,
  stable_key, arrival ordinal)` 稳定排序；时间并列时结果可重复。
- 输入记录中的 schema version、时间戳、载荷和稳定键原样保留在输出事件中。

## 使用

```cpp
#include "dataeng.hpp"

dataeng::RingBufferMerger merger;

merger.push(dataeng::RingRecord{
    /*cpu*/ 0, /*sequence*/ 0, /*lost*/ 0, /*timestamp*/ 100, /*schema*/ 3});
merger.push(1, 0, 0, 120, 3);

// sequence 1 缺失：生成一条显式 loss，再输出 sequence 2。
merger.push(0, 2, 0, 140, 3);

std::vector<dataeng::MergedEvent> stream = merger.finish();
```

`finish()` / `drain()` / `flush()` 返回排好序的全部事件并清空队列；
`events()` / `merged_events()` / `snapshot()` 返回排序副本但不消费队列。
流式消费可使用 `pop_ready(watermark)`：调用方保证 watermark 之后不会再有更早时间戳的
记录到达。

批量入口：

```cpp
auto events = dataeng::merge_records(records);
auto events = dataeng::merge_cpu_streams(per_cpu_records);
```

## 事件字段

`MergedEvent::kind == EventKind::Loss` 表示合成 loss 事件；`EventKind::Record` 表示
原始数据记录。常用字段同时提供语义别名，例如 `sequence`/`seq`、
`timestamp`/`timestamp_ns`、`schema_version`/`schema`。对于 loss 事件，
`lost` 是本次显式丢失数量，`lost_counter` 是发现缺口时的累计计数器。

`MergeStats` 汇总输入数、输出记录数、loss 事件数、缺失 sequence 总数、lost 计数器增量、
重复记录数以及被拒绝的回填数。
