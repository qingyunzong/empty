# Barrier 对齐与非对齐快照

流引擎需要可嵌入 C++ checkpoint barrier 协调器，多输入算子可在对齐超预算时切换 unaligned。切换瞬间准确记录各 channel 在途缓冲，重复 barrier 幂等，旧 checkpoint barrier 不阻塞新世代。恢复后不漏不重，并保存模式切换证据。

## 嵌入方式

算子持有 `dataeng::BarrierCoordinator`（构造参数：输入 channel 数、对齐预算毫秒），将每个输入事件（`Buffer` 或 `Barrier`）连同逻辑时间戳交给 `on_event()`，并定期调用 `poll()` 以便无新事件时也能触发超时切换。协调器返回一组 `Action`：

- `ForwardBuffer`：放行数据缓冲。
- `EmitBarrier`：向下游广播 barrier。
- `CompleteCheckpoint`：携带 `CheckpointSnapshot`（unaligned 时含各 channel 在途缓冲）。
- `AbortCheckpoint`：旧 checkpoint 被更新世代抢占。

模式切换证据通过 `evidence_log()` 读取，可用 `evidence_to_json()` 持久化。恢复时用 `restore_plan(snapshot)` 得到需按 channel 重放的在途缓冲，重放后再从 barrier 之后恢复流，保证不漏不重。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```
