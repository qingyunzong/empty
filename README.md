# dlks_formal

可嵌入的 C++20 有界指标聚合组件（header-only，仅依赖标准库）。

监控代理在标签组合爆发时不能无限增长。本组件为每个指标维护独立的内存预算：
预算内保留高频 label 组合，其余增量精确合并到该指标唯一的 overflow 序列；
空闲标签过期后释放计费；哈希碰撞只影响探测路径，不会混合不同键。

## 快速开始

```cpp
#include "dlks_formal.hpp"

#include <vector>

dlks::Aggregator<128> agg;  // 每个键内联 128 字节规范编码

dlks::MetricConfig config;
config.memory_budget_bytes = 32 * 1024;
config.label_ttl_ns = 5 * 60'000'000'000ULL;  // 5 分钟空闲过期
config.retention = dlks::RetentionPolicy::ProtectResidents;  // 默认

agg.define_metric("http_requests_total", config);

std::vector<dlks::Label> labels{
    {"service", "checkout"},
    {"code", "200"},
};

agg.observe("http_requests_total", labels, 1, /*now_ns=*/1'000);
agg.expire(/*now_ns=*/2'000);

auto snapshot = agg.metric_snapshot("http_requests_total");
for (const dlks::SeriesPoint& point : snapshot->series) {
    // point.labels, point.count, point.last_seen
}

// overflow 是该指标唯一的受控残余序列，始终存在。
const std::uint64_t overflow = snapshot->overflow.count;
const std::uint64_t total = snapshot->total_count();  // series 之和 + overflow
```

`now_ns` 由调用方提供，约定为单调递增的纳秒时间。组件不自带时钟，也不启动后台
线程；是否以及何时调用 `expire()` 由监控代理的采集周期决定。`snapshot()` 是只读
操作，不会隐式改变状态。单指标嵌入场景可以直接使用 `BasicMetricShard<KeyBytes>`，
跳过注册表；`BasicAggregator` 只是为每个指标各建一个 shard。

`delta == 0` 视为一次 touch：已存在的保留序列只刷新 `last_seen`；未知键不会因此
占用槽位（返回 `ObserveStatus::Ignored`）。

## 不变量

对每个指标，任意操作序列之后都成立：

1. **总计数守恒**：`sum(retained series count) + overflow.count` 等于该指标收到的
   所有 `delta` 之和（`uint64_t` 饱和加法；正常小域不会触及上限）。
2. **内存上限**：`reserved_bytes = physical_slots * slot_bytes <=
   memory_budget_bytes`，且 `accounted_bytes = live_series * slot_bytes <=
   memory_budget_bytes`。
3. **基数上限**：`live_series <= max_series = physical_slots - 1`。保留一个空槽，
   使线性探测的后移删除总能终止。
4. **键隔离**：哈希相等只是候选条件；查找还会比较完整规范编码的长度与字节。
   两个不同键即使哈希完全碰撞，也不会合并成同一个序列。
5. **overflow 唯一**：每个指标恰好一个 overflow 序列；被淘汰、过期、超长键和无
   容量时的增量都只进入该指标的 overflow。

`overflow.last_seen` 是折入 overflow 的样本时间的最大值：直接并入的增量使用当前
`now`，淘汰/过期折入的计数使用原序列的 `last_seen`。

## 内存模型

每个槽位包含固定 `KeyBytes` 的内联 label 编码，以及计数、最后访问时间、哈希和
长度等元数据。槽位数在构造时一次算定：

```
physical_slots = floor(memory_budget_bytes / sizeof(Slot))
max_series     = physical_slots == 0 ? 0 : physical_slots - 1
```

`Slot` 大小由 `KeyBytes` 决定，可用 `Aggregator<>::slot_bytes()` 获取；
`Aggregator<>::max_series_for(budget)` 可在编译期算出给定预算能保留多少序列。
表只分配一次，不会随基数增长而扩容，因此 `reserved_bytes` 是硬上限。

预算约束的是**保留序列表**。`BasicMetricShard` 自身的 O(1) 元数据、指标名表和
分配器内部记账不在该预算内；这使得预算可以小到 `sizeof(Slot)` 而不会出现
“对象本身已超预算”的矛盾。调用 `expire()` 后，过期项会立刻降低
`accounted_bytes`（释放计费），但不会把预分配的表还给分配器，从而保持后续插入
的确定性上界。

`snapshot()` 为报告构造 `std::vector`/`std::string`，这些临时分配属于调用方可见的
报告开销，不计入 shard 的常驻表预算。

标签集编码为按 `(key, value)` 排序后的长度前缀字节串，因此同一标签集合的不同
输入顺序得到同一个键。编码长度超过 `KeyBytes` 时，增量精确进入 overflow，并返回
`ObserveStatus::KeyTooLong`。重复的 key/value 对按排序后的重复项保留，不做隐式
合并，以保证确定性。

## 保留策略

- `ProtectResidents`（默认）：只保护计数**严格高于**本次增量的已有序列。新增量
  低于当前最小计数时直接并入 overflow；等于最小计数时允许新键替换最旧/最小
  的平局项，因此全是 count=1 的表仍然允许新键进入并累积。这一策略适合“已有一批
  高频项，随后涌来大量一次性标签”的基数爆发；代价是只以很小单次增量出现、且
  始终低于当前阈值的新键可能无法进入表（等旧项过期后才会获得机会）。
- `EvictLeastFrequent`：每个新键都尝试进入表。表满时无条件选计数最小的序列，
  把它的计数精确折入 overflow，再用新键的第一个增量占用槽位。它能更快适应新的
  高频键，但每次低于阈值的爆发可能挤掉一个已建立的保留项。

最小值的确定性 tie-break 为：计数升序、`last_seen` 升序、规范编码字节序升序。

保留序列内的计数是精确的。若一个键被淘汰或过期后再次出现，它之前的计数已经在
overflow 中，新序列从零开始。聚合总量始终精确；单个键的“生命周期累计值”不保证
可恢复——这正是用固定内存换取有界基数的语义。

## 过期语义

- TTL 是距离 `last_seen` 的空闲时间；`now - last_seen >= ttl` 时过期（恰好等于
  TTL 也算过期）。
- `ttl_ns == 0` 关闭过期。
- `expire(now)` 扫描并删除所有过期序列，把计数折入 overflow，同时减少
  `accounted_bytes`。
- 对一个仍在表中、但已超过 TTL 的键再次 `observe(delta > 0)` 时，旧计数先折入
  overflow，新样本从零开始，语义与“先 expire 再 observe”一致。
- 时间倒退不会触发过期；`last_seen` 取历史最大值。
- overflow 自身是 O(1) 控制序列，不参与 TTL；窗口轮转时可用
  `reset_metric(name)` 清零该指标的保留序列和 overflow，同时保留配置。

## 哈希与碰撞

默认使用 FNV-1a 64 位哈希，可通过 `BasicAggregator<KeyBytes, Hasher>` /
`BasicMetricShard<KeyBytes, Hasher>` 替换。表是开放寻址 + 线性探测；删除使用
后移（backward-shift）算法，保持其他键的探测链完整。

查找条件为：

```
slot.hash == hash && slot.key_len == key_len && memcmp(slot.key, key, key_len) == 0
```

因此哈希碰撞只会增加探测长度，不会把两个键的计数混在一起。测试中用恒定哈希
（所有键哈希值相同）验证了插入、淘汰、过期和重新插入路径。

## 测试与验证

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试包含：

- **精确小域模型**：固定 8 个操作（3 个键上的 5 种增量、时间推进、expire），
  对 4 种配置穷举深度 4、对 2 种配置穷举深度 5，共 81,920 条完整操作序列。
  每条序列的每一步都与 `std::map` 参考总计对拍，检查总计数守恒、`accounted`/
  `reserved` 上限、基数上限、overflow 唯一性、无重复规范键。
- **策略级差分模型**：独立实现的 `RefShard` 逐项比较保留键、每个键的计数和
  `last_seen`、overflow 计数/时间、淘汰次数和过期次数；覆盖两种保留策略、
  容量 0/1/3/6、TTL 0/3/4、普通哈希和恒定哈希。
- **随机压力**：2 万步多键随机操作 + 5000 步恒定哈希碰撞压力。
- **边界**：TTL 恰好到期、时间倒退、零 TTL、零预算、单槽预算、超长键、标签
  重排/重复键、`uint64_t` 饱和。

当前构建在 ASan + UBSan 下通过（LeakSanitizer 在该容器受 ptrace 限制，使用
`detect_leaks=0`），约 1099 万次断言，0 失败。

## 复杂度与限制

- 更新：平均 O(1)（线性探测）；表满时找最小项需 O(max_series)。
- 过期：典型 O(max_series)；最坏 O(max_series * 过期数)，因为原地后移删除后需要
  重新扫描。适合每指标几十到几千个保留序列的嵌入式预算。
- 单线程组件；多线程共享时由调用方加锁。
- 不负责持久化、指标名注册的生命周期管理或时间源；这些属于监控代理的上层。
- 指标名是注册表的键，不进入每个 shard 的槽位编码，也不占用每指标预算。
