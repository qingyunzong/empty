# dlks_formal

可嵌入的 C++20 拥塞控制组件。实现 Reno/NewReno 窗口状态机、SACK
记分板、RFC 6298 RTT/RTO 估计和发送在途量核算；只依赖标准库，头文件式，
无时钟、无随机数、无 I/O，给定事件序列时完全确定。

## 快速使用

```cpp
#include "dlks_formal.hpp"

using namespace dlks_formal;

CongestionConfig cfg;
cfg.mss = 1460;
cfg.initial_cwnd = 10 * cfg.mss;      // 也可保留 0，使用 RFC 6928 初值
cfg.initial_ssthresh = 64 * cfg.mss;

CongestionController cc(cfg);

// 发送侧先按窗口和在途量判断，再登记新数据。
if (cc.can_send(len) && cc.try_send(len)) {
  send_packet(seq, len);
}

// 累计确认；SACK 块是 [left, right) 的字节区间。
SackBlock blocks[] = {{seq + 1460, seq + 4380}};
cc.on_ack(ack, blocks);
cc.on_rtt_sample(rtt_us);

// 丢包处理。
cc.on_duplicate_ack();   // 或 on_loss()/on_timeout()

Bytes window = cc.cwnd();
CongestionState state = cc.state();
```

`on_send()`/`on_packet_sent()` 用于登记已经交给网络的数据；如果希望组件
代替调用方做“不超发”门控，使用 `try_send()`。`can_send()` 比较的是
`cwnd` 与 `pipe = 在途字节 - 已被 SACK 的字节`，因此在恢复阶段和 ACK
乱序时不会把已选择性确认的数据重复计入在途量。

## 状态机

| 状态 | 进入条件 | 窗口增长 |
| --- | --- | --- |
| `SlowStart` | `cwnd < ssthresh` | 每个 ACK 增加 `min(newly_acked, MSS)` |
| `CongestionAvoidance` | `cwnd >= ssthresh` | 每个 ACK 增加 `MSS*MSS/cwnd` |
| `FastRecovery` | 3 个重复 ACK 或显式 `on_loss()` | 进入时 `cwnd = ssthresh + 3*MSS`；每个后续重复 ACK 再加 `MSS` |

丢失响应：

- 快速重传：`ssthresh = max(FlightSize/2, 2*MSS)`，`recover` 记录恢复点。
- 部分 ACK（NewReno）：`cwnd = cwnd - newly_acked + MSS`，仍留在快速恢复。
- 恢复点之后的完整 ACK：`cwnd = ssthresh`，状态切回
  `CongestionAvoidance`；下一个 ACK 才开始正常的避免阶段增长。
- 超时：`ssthresh = max(FlightSize/2, 2*MSS)`，`cwnd = MSS`，回到慢启动，
  并按 RFC 6298 对 RTO 指数退避。

重复 ACK 的计数规则：

- 每个到达的 ACK 事件最多贡献一次重复确认计数，不按 SACK 块或段数重复计数。
- 若需要 RFC 6675 式的“新 SACK 段参与丢包判定”，设置
  `Config::count_sacked_segments_as_dupacks = true`。
- `ack < snd_una` 的陈旧/乱序 ACK 被完全忽略，不改变窗口、阈值或计数。
- 已在快速恢复时再次调用 `on_loss()` 是幂等的，不会重复减半。

## 变更日志

`history()`（别名 `changes()`、`window_changes()`、`change_log()`）按事件
顺序保存每一次 `cwnd`、`ssthresh` 或状态变化：

```cpp
struct WindowChange {
  std::uint64_t sequence;       // 从 1 开始
  TimePoint timestamp;
  ChangeReason reason;          // ACK/重复 ACK/快速重传/部分 ACK/恢复退出/超时...
  Bytes old_cwnd, new_cwnd;
  Bytes old_ssthresh, new_ssthresh;
  CongestionState old_state, new_state;
  SeqNum ack;
  std::uint64_t duplicate_acks;
  Bytes bytes_in_flight;
};
```

只有值或状态真正改变时才登记；同一事件内 `cwnd` 与 `ssthresh` 的变化
合并为一条原子记录，记录中的旧值严格等于上一条记录的新值。

## 确定性验证

`tests/test_congestion_control.cpp` 包含：

- 一条固定的字节级包轨迹，逐步核对每个事件后的 `cwnd`、`ssthresh`、
  状态、在途量和重复 ACK 数，并核对 17 条窗口变更记录的旧值/新值链。
- SACK 记分板、部分确认、恢复退出、陈旧 ACK 和 `try_send()` 不超发测试。
- RFC 6298 RTT/RTO 数值测试。
- 4000 个确定性事件的 fuzz 轨迹，与独立实现的规范状态模型逐事件对照。

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

## 约定

- 所有序列号和窗口单位都是字节；把 `mss` 设为 1 即可按段编号使用。
- `TimePoint` 是调用方给出的逻辑时间，组件不读取系统时钟。
- 默认初值遵循 RFC 6928；需要教科书式 `cwnd = 1*MSS` 时显式设置
  `Config::initial_cwnd`。
- 组件实例不是线程安全的；每个连接/控制器实例独立使用。
