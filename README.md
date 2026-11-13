# OTLP delta 指标累积组件

`dataeng` 是一个无第三方依赖、可嵌入进程的 C++20 delta-to-cumulative
状态组件。它只负责有状态的指标换算，不绑定 OTLP protobuf；调用方将
resource、scope、metric 和 data point 转换成本项目的结构即可。

## 状态隔离

每条时间序列由以下内容共同标识：

- resource attributes
- instrumentation scope 的 name、version 和 attributes
- metric 的 name、unit、类型及 monotonic 标记
- data point 的完整 attributes

attribute key 使用自描述、带长度前缀的规范编码。键的顺序固定，并且保留
值的类型，因此整数 `1`、浮点 `1.0` 和字符串 `"1"` 属于不同序列。
`make_series_key()` 可用于调试或与外部索引对齐。

## 使用方式

```cpp
#include "dataeng.hpp"

dataeng::MetricDescriptor metric;
metric.resource.attributes = {{"service.name", "checkout"}};
metric.scope.name = "example.instrumentation";
metric.name = "http.server.requests";
metric.unit = "{request}";
metric.type = dataeng::MetricType::Sum;
metric.is_monotonic = true;

dataeng::Options options;
options.reorder_window_ns = 1'000'000'000;  // 1s
dataeng::DeltaToCumulative converter(options);

dataeng::NumberDataPoint delta;
delta.attributes = {{"http.method", "GET"}};
delta.start_time = 1'700'000'000'000'000'000ULL;
delta.time = 1'700'000'001'000'000'000ULL;
delta.value = 3;

for (const dataeng::DataPoint& published :
     converter.ingest(metric, delta)) {
  // published 是已按观测时间排序、可安全下发的累计点。
}

// 批次结束或需要立即排空时调用。调用后，已发布时点之前的迟到 delta
// 不会再改变累计结果。
for (const dataeng::DataPoint& published : converter.flush()) {
  // ...
}
```

`ingest()` 可以在一次调用中返回 0 到多个点：窗口内较早的点会在后续
时间点推进水位后才发布。输入按批处理时也可使用 `ingest(metric, span)`
或 `convert(metric, points, options)`。

## 窗口与迟到数据

组件为每个序列维护最后发布水位：

1. 新 delta 先进入按观测时间排序的窗口。
2. `horizon = max_seen_time - reorder_window_ns`。
3. 观测时间不晚于 `horizon` 的点按时间顺序应用并发布。
4. 比水位更老、或时间不晚于已发布点的 delta 被直接丢弃，不修改任何
   已发布的累计值。
5. `flush()` 强制排空所有窗口中的点，之后同样的迟到数据仍会被丢弃。

窗口默认是 `0`，即严格按到达顺序发布。需要容忍乱序时显式设置
`Options::reorder_window_ns`。`max_pending_points_per_series` 提供内存
上限；超过上限时最早的点会被提前发布，同时形成新的迟到水位。

## 重置语义

每个序列维护当前累计世代的 `start_time`。第一个 delta 的 start time
成为输出世代起点。正常 delta 的区间 start time 会随采集周期推进
（如 `(T0,T1]`、`(T1,T2]`），只要新 start time 正好接续上一观测时间，
就仍然属于同一累计世代。真正跳前的 start time、未知且更小的 start
time（时钟回拨）或退役世代的重新出现才会开启新世代。新世代从当前
delta 重新累计，并在输出中使用新的 `start_time`。

| 类型 | 累积方式 | 重置条件 |
| --- | --- | --- |
| 单调 Sum | 累加 delta | 世代变化；负 delta 会使累计值下降 |
| 非单调 Sum | 累加 delta | 仅世代变化，允许负 delta |
| Gauge | 保留最新点 | 不做累计，保留最新观测 |
| Histogram | count/sum/bucket 逐项累加 | 世代变化；explicit bounds 形状变化 |
| ExponentialHistogram | count/sum/zero_count 累加，bucket 按较粗 scale 合并 | 世代变化 |
| Summary | 无法合并分位数，保留最新快照 | 世代变化 |

单调 Sum 的重置会将当前 delta 作为新累计值。Histogram 和
ExponentialHistogram 的计数使用饱和加法保护 `uint64_t` 溢出；显式
Histogram 要求 `bucket_counts.size() == explicit_bounds.size() + 1`，
只跟踪 count/sum 时允许两个 bucket 数组都为空。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

`DeltaToCumulative` 本身不加锁。多线程接入时，每个线程使用独立实例，
或在外部串行化访问；同一个实例内的所有状态和窗口都按序列隔离。
