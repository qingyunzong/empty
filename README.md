# dlks_formal

可嵌入的 C++20 HTTP/2 发送侧流量控制组件。它只对 DATA 帧计费，分别维护连接窗口和每条流的窗口，并在分配帧配额时原子扣减两级窗口。

## 特性

- 连接与流窗口独立维护，默认均为 65535，最大均为 `2^31-1`。
- 处理 `SETTINGS_INITIAL_WINDOW_SIZE` 增量变化，允许流窗口暂时为负，连接窗口不受影响。
- 校验 `WINDOW_UPDATE`：增量为 0 返回 `PROTOCOL_ERROR`，窗口超过 `2^31-1` 返回 `FLOW_CONTROL_ERROR`。
- 连接错误会锁存失败状态并阻止后续发送；流错误会重置该流并清空待发数据。
- `RST_STREAM` 后停止调度该流，迟到的 `WINDOW_UPDATE` 被忽略。
- 多流发送使用 1..256 权重的加权公平队列，避免低权重流永久饥饿。
- `next_frame` 返回的配额已经同时扣减连接窗口、流窗口和待发字节，调用方不得发送超过该长度的 DATA 负载。

## 使用

```cpp
#include <dlks_formal.hpp>

dlks_formal::FlowController flow;
flow.open_stream(1, dlks_formal::Priority{.weight = 32});
flow.enqueue_data(1, payload_size);

while (const auto grant = flow.next_frame(16'384)) {
    write_data_frame(grant->stream_id, grant->length);
}

flow.receive_window_update(0, connection_credit);
flow.receive_window_update(1, stream_credit);
```

`sendable_bytes(stream_id)` 返回当前两级窗口允许的最大 DATA 长度，不包含待发队列限制。需要绕过优先级队列、直接为指定流预留配额时使用 `reserve_data`：

```cpp
if (const auto grant = flow.reserve_data(1, wanted, 16'384)) {
    write_data_frame(grant->stream_id, grant->length);
}
```

应用 SETTINGS 时建议显式构造设置对象，避免只初始化部分可选字段：

```cpp
dlks_formal::Settings settings;
settings.initial_window_size = 131'072;
if (const auto error = flow.apply_settings(settings)) {
    close_connection(error->code);
}
```

错误对象同时携带作用域：

```cpp
if (const auto error = flow.receive_window_update(stream_id, increment)) {
    if (error->scope == dlks_formal::ErrorScope::connection) {
        send_goaway(error->code);
    } else {
        send_rst_stream(error->stream_id, error->code);
    }
}
```

## 状态规则

- 新流窗口取当前 `peer_initial_window_size()`。
- 对端 SETTINGS 改变初始窗口时，差值一次性应用到所有未重置的流；任一窗口溢出则整个更新失败并产生连接级 `FLOW_CONTROL_ERROR`。
- 连接级 `WINDOW_UPDATE` 增加连接窗口；流级只增加对应流窗口，不改变连接窗口。
- 流级零增量或溢出会产生流错误，并立即把该流标记为已重置。
- 已发送 END_STREAM 或收到 RST_STREAM 的流不会进入调度器，`sendable_bytes` 返回 0。
- 调度权重限制在 1..256；权重越大，长期可分到的 DATA 字节越多。

## 测试

测试包含独立的规范参考模型和确定性帧序列生成器。生成器覆盖合法演进与对抗性边界序列，逐步比较错误码、错误作用域、连接/流窗口、待发字节和可发送字节；调度器另外检查每帧不超过两级窗口。

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
