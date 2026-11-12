# 采集事件的拓扑依赖交付

## 组件

零依赖 TypeScript 实现，入口为包根 `index.ts`（编译后 `dist/index.js`）：

- `src/synthesizer.ts` — `EventSynthesizer` 合成器与 `EventEnvelope`、`SynthesisReport` 类型
- `src/store.ts` — 调用方实现的持久存储接口 `ConfirmationStore`（`isConfirmed` / `markConfirmed`）
- `src/errors.ts` — 可按类型捕获的错误：内容冲突、写入结果不明、读取失败、已停止等
- `test/faulty-store.ts` — 可注入故障的内存存储（读失败、写失败、写成功但响应丢失）
- `test/synthesizer.test.ts` — 基于 `node:test` 的 15 个场景测试

## 语义

- 事件 `ingest` 可乱序、重复到达；同 ID 再次到达时前驱集合与载荷必须结构一致，否则抛出
  `ConflictingEventError` 并保留首份内容，完全重复的到达为幂等空操作。
- 单消费者通过 `take()` 取事件：仅当某事件的全部直接前驱都已确认时才就绪，就绪且未确认的事件
  按 ID 字典序取最小者；持有期间重复 `take()` 返回同一事件，`confirm()` 或 `release()` 前不会
  交付其他事件。
- `confirm()` 把确认标记写入调用方存储。写入成功即永久不再重发；写入抛错代表结果不明，事件保持
  持有并在下次 `take()`/`release()` 时先读标记——已确认则不重发，未确认才允许以相同 ID 重发。
- 进程恢复时对新实例重新 `ingest` 事件后调用 `recover(ids)`，逐 ID 读标记；任何读取失败都会令
  合成器进入停止状态（`stopped === true`，后续操作抛 `SynthesizerStoppedError`），需由新实例恢复。
- `finish()` 结束输入并返回：从未到达的直接前驱 ID 列表，以及仅由已到达节点构成的依赖图中的
  强连通环（Tarjan SCC，含自环）；缺失节点不是图顶点，绝不会被误报为环。

## 构建与测试

当前 Node 构建不支持 `--experimental-strip-types`，因此先用全局 `tsc` 编译再运行内置测试运行器：

```bash
npm run typecheck   # 仅类型检查
npm test            # tsc 编译到 dist/ 后运行 node:test（4 个套件、15 个用例）
```

最小用法：

```ts
import { EventSynthesizer } from './index.js';

const store: ConfirmationStore = {
  async isConfirmed(id) { /* 读持久标记 */ return false; },
  async markConfirmed(id) { /* 持久化标记 */ },
};
const synthesizer = new EventSynthesizer(store);
synthesizer.ingest({ id: 'b', predecessors: ['a'], payload: { v: 1 } });
synthesizer.ingest({ id: 'a', predecessors: [], payload: null });

const event = await synthesizer.take(); // 'a'
await synthesizer.confirm();
const report = synthesizer.finish();    // { missingPredecessors: [], cycles: [] }
```
