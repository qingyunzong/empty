# logical-time-scheduler

逻辑时间调度测试库（TypeScript，零运行时依赖）。

## 语义约定

- **到期交付**：推进逻辑时间（`advanceTo` / `tick`）时只交付 `time <= now` 的已到期事件；
- **ID 有序**：同一时刻的事件（含微任务）按注册 ID 升序交付；
- **同刻队尾**：交付过程中新增的同刻事件追加到当前待交付队列的队尾；
- **预算续跑**：单次推进可携带交付预算 `budget`，预算耗尽后返回 `exhausted: true`，
  可调用 `resume()` 在不推进时间的情况下续跑；
- **轨迹输出**：`trace()` 返回 `{ time, id, kind, label }` 交付轨迹，
  `formatTrace()` 输出 `t=5 #1 io:pay` 形式的文本；
- **拒绝后退**：`advanceTo` 更早时刻抛出 `ClockBackwardsError`，`tick` 负增量抛出 `RangeError`；
- **取消与重入**：`cancel(id)` 取消未交付事件；事件回调中可重入地注册、取消事件。

## 示例

```ts
import { LogicalScheduler } from './src/scheduler';

const scheduler = new LogicalScheduler();
scheduler.scheduleIO(5, 'pay');
scheduler.scheduleMicrotask('sync');

scheduler.advanceTo(5, 1); // { delivered: 1, remaining: 1, exhausted: true }
scheduler.resume();        // 续跑剩余事件
console.log(scheduler.formatTrace());
// t=0 #2 microtask:sync
// t=5 #1 io:pay
```

## 测试

```sh
npm test
```

先以 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行
`test/scheduler.test.ts`。其中「列表模型核验取消及重入」用独立的
全表扫描列表模型对 400 步确定性随机操作序列（注册 / 取消 / 推进 /
预算续跑，含回调内重入注册与取消）与调度器逐条比对交付轨迹。

环境需要可用的 `tsc`（`npm i -D typescript` 或全局安装）。
