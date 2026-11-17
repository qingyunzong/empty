# QUIC Recovery (TypeScript)

可嵌入的 QUIC 丢包恢复组件，按 RFC 9002 实现。组件只负责恢复状态，不负责
包编码、加密或拥塞控制，适合被 QUIC transport 直接嵌入。

## 能力

- 独立维护 `initial`、`handshake`、`application` 三个包号空间。
- ACK range 归一化、合并与二分查找；宽范围不会按包号分配内存。
- RTT/PTO 估计，`max_ack_delay` 仅用于已确认握手后的 Application Data。
- 包阈值（默认 3）与时间阈值（默认 9/8）丢包检测。
- 每空间 PTO 指数退避，ACK 新确认 ack-eliciting 包后重置。
- 定时器优先级：已布置的 loss timer 优先于 PTO。
- 帧级在途账本：同一逻辑帧的多个副本只计一次在途字节。
- 内置结构不变量检查，便于宿主调试和确定性回放。

## 构建与测试

```bash
npm run build
npm test
npm run typecheck
```

`npm test` 会编译 `src/` 到 `build/`，然后运行 `test/*.test.mjs`。

## 快速开始

```ts
import { QuicRecovery } from './src/index.ts';

const recovery = new QuicRecovery({
  initialRtt: 333,
  granularity: 1,
  maxAckDelay: 25,
  packetThreshold: 3,
});

recovery.sendPacket({
  space: 'initial',
  now: 0,
  frames: [{ id: 'client-initial-crypto', size: 1200 }],
  overheadBytes: 0,
});

recovery.onAckReceived({
  space: 'initial',
  now: 100,
  ranges: [{ smallest: 0, largest: 0 }],
  ackDelay: 5,
});

const timer = recovery.getTimer();
if (timer?.kind === 'loss') {
  const lost = recovery.detectLostPackets(timer.space, 100);
  // 用 lost[*].frames 中 retransmittable 的帧重新组包。
} else if (timer?.kind === 'pto') {
  // 发送 timer.probeCount 个探测包；可复用原帧 id。
}
```

时间统一使用毫秒，且所有 `now` 必须单调不减。PTO 触发后组件只增加退避
计数并返回探测事件，探测包由宿主发送；发送探测包会刷新该空间的 PTO 基准
时间。

## 关键语义

### 包号空间

每个空间独立维护 `nextPacketNumber`、`largestSent`、`largestAcked`、在途
包、PTO 计数和 loss time。ACK 只影响指定空间。帧 id 也在各空间内独立；
不同空间可以使用相同 id。

### ACK ranges

输入 range 可为任意顺序、可重叠。组件会校验、降序排序并合并重叠或相邻
范围，例如 `[4,7] + [2,3]` 合并为 `[2,7]`；有缺口时保持分离。ACK 的最大
包号不能超过该空间已发送的最大包号。

### RTT 采样

- 仅在 ACK 新确认至少一个 ack-eliciting 包时采样。
- 样本取“最大新确认 ack-eliciting 包”的发送时间，不使用更旧的乱序包、
  ACK-only 包或已确认过的包。
- 首个样本直接初始化 `min_rtt`、`smoothed_rtt = sample`、
  `rttvar = sample / 2`，且不扣 ACK delay。
- 后续样本先更新 `min_rtt`；仅当 Application Data 且握手已确认时，扣减
  `min(ackDelay, maxAckDelay)`，且不得使 adjusted RTT 低于 `min_rtt`。
- 重复 ACK 不产生新样本，也不会改变 `latest_rtt`。

### 丢包检测

对每个空间中 `packetNumber < largestAcked` 的在途包：

- 包阈值：`packetNumber + packetThreshold <= largestAcked`。
- 时间阈值：`sentAt + max(9/8 * max(smoothedRtt, latestRtt), granularity) <= now`。

ACK 到达后立即执行一次检测；时间阈值尚未到的包会设置该空间的
`lossTime`，由 loss timer 在到期时触发剩余检测。被判定丢失的包返回在
`AckResult.lost` 或 `TimerResult.lost` 中。

### PTO

基础 PTO 周期：

```text
smoothedRtt + max(4 * rttvar, granularity)
```

Application Data 额外加 `maxAckDelay`。第 `n` 次 PTO 的截止时间为：

```text
lastAckElicitingSentAt + basePto * 2^n
```

- Application space 在 `confirmHandshake()` 之前不布置 PTO。
- ACK 新确认 ack-eliciting 包时，将该空间 `ptoCount` 清零。
- PTO 事件返回 `probeCount`（默认 2）；组件不自动重发帧，也不改变
  在途字节。

### 定时器优先级

`getTimer()` 与 `onTimer(now)` 遵循：

1. 任一空间存在 loss time，则只暴露最早的 loss timer，即使其他空间的 PTO
   时间更早。
2. 没有 loss timer 时，选择各空间最早的 PTO；同刻按
   `initial -> handshake -> application` 排序。
3. loss 与 PTO 同刻时 loss 优先。

`onTimer(now)` 在 loss timer 尚未到期时返回 `kind: "none"`，不会越过
loss timer 提前触发 PTO。

### bytes_in_flight

组件采用帧级去重账本，严格维持以下守恒式（按空间分别成立，全局为各空间
之和）：

```text
bytesInFlight =
  sum(unique, not-yet-delivered frame.size)
  + sum(outstanding packet.overheadBytes)
```

`overheadBytes` 用于宿主提供的每包非帧开销（例如 UDP/IP/QUIC header），
按包计数。这样做的效果是：

- 首次发送某帧时增加 `frame.size`。
- 用相同帧 id 重传（包括 PTO 探测包）不会再次增加该帧的字节。
- 任一副本被 ACK 后，逻辑帧视为已交付并立即从在途字节中移除。
- 一个副本丢失但仍有其他副本在途时，不扣减；最后一个副本消失时才扣减。
- 所有 ACK/丢失事件幂等，重复处理不会产生负数或二次扣减。

每个 `SentPacket.wireBytes` 仍为“该包帧字节 + 该包 overhead”，可用于宿主
侧统计；拥塞控制应使用去重后的 `bytesInFlight`。

约束：重传同一帧必须复用相同 id 且 `size` 不变，组件会拒绝大小变化的
重传。帧 id 在每个包号空间内唯一。

## 不变量与调试

```ts
const errors = recovery.checkInvariants(); // [] 表示健康
recovery.assertInvariants();                // 失败时抛错

const all = recovery.snapshot();            // 全空间快照
const app = recovery.getSpaceSnapshot('application');
const frames = recovery.getInFlightFrames('application');
const packets = recovery.getOutstandingPackets('application');
```

`getInFlightFrames()` 只返回尚未交付且正在计费的逻辑帧，并列出仍携带该帧的
包号，可直接用于重算 `bytes_in_flight`。`discardSpace()` 在丢弃密钥时释放
该空间全部在途字节并停止其定时器。

## 确定性轨迹测试

`test/helpers.mjs` 的 `runTrace()` 逐步执行带时间戳的 send/ACK/timer 事件，
并在每个事件后调用 `assertConservation()` 重算上述守恒式。覆盖：

- `test/traces.test.mjs`：乱序 ACK range、时间/包阈值丢包、合并重传、
  PTO 退避与探测帧复用、loss timer 压制更早的 PTO。
- `test/recovery.test.mjs`：三空间隔离、RTT 采样选择、ACK delay、
  PTO 重置、重复副本丢失、空间丢弃。
- `test/property.test.mjs`：固定种子的 1200 步混合 send/ACK/timer 回放，
  每步重算守恒式。
- `test/rtt.test.mjs`、`test/ack-ranges.test.mjs`：RTT 数学与 ACK range
  边界/缺口。

## 范围外

- 拥塞控制、pacing、ECN。
- 包编码/解码、加密级别与密钥更新。
- 自动选择重传帧或自动发送 PTO 探测包。
- 连接级错误处理策略；非法 ACK、时间倒退等会抛出异常，由宿主决定是否
  关闭连接。
