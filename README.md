# 事件总线投递窗口

供流处理器使用的 TypeScript 投递窗口。它把消息分成“待投递”“在途”“已确认”三种状态，并把已确认前缀之外的数据保留到连续水位推进为止。

## 语义

- **有限在途**：`capacity` 约束“不同消息”的在途数量。同一条消息重投时复用原额度，不会二次占位。
- **累计确认**：`ackCumulative(seq)` 确认 `seq` 及之前的全部消息。
- **选择确认**：`ackSelective(seq | seqs)` 只确认指定消息；乱序确认会保留，但水位只跨过连续确认前缀。
- **确认前提**：只能确认已经首次投递过的序号，提前确认会抛 `SequenceNotDeliveredError`。
- **稳定重投**：`nack(seq)` 把在途消息放入重投队列，按首次 `nack` 的 FIFO 次序投递；重复 `nack` 不会改变次序或增加额度。
- **消费者取消**：`cancel(reason)` 立即停止投递、拒绝等待中的 `next()`，并按序号返回尚未释放的消息（含状态和投递次数），便于交接或审计。
- **背压**：`maxBuffered` 可限制尚未首次投递的积压；`push` 溢出时抛 `BufferFullError`，`tryPush` 返回 `null`。

## 使用

```ts
import { DeliveryWindow } from "dlks-formal-10164";

const window = new DeliveryWindow<Uint8Array>({
  capacity: 32,
  maxBuffered: 1024,
});

window.push(payload);

const delivery = await window.next();
try {
  await processor.handle(delivery.value);
  window.ackSelective(delivery.seq);
} catch {
  window.nack(delivery.seq);
}
```

同步消费可改用 `poll()`；`window.next()` 也可传入 `AbortSignal` 取消单次等待。构造参数中的 `signal` 会取消整个窗口。

## 校验

`npm test` 会先编译，再运行固定场景和随机模型测试。随机测试使用 40 个种子、每个 500 步的混合操作，逐步骤对照一个独立的确认位图模型，检查：

- 水位等于位图中最长的连续确认前缀；
- 任何消息都不会在确认前被释放；
- 每条已推送消息恰好首次投递一次，载荷和序号不丢失；
- 在途数等于“已投递且未确认”的不同消息数，且不超过 `capacity`；
- 重投严格遵循 `nack` 的 FIFO 次序，`attempt` 计数正确；
- 取消报告与模型保留窗口逐项一致。

```sh
npm run typecheck
npm test
```
