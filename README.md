# 虚拟列表采集的锚点恢复

浏览器采集宿主通过适配器驱动的 TypeScript 虚拟列表采集组件。组件只依赖
`VirtualListAdapter` 接口，不接触 DOM 或网络；宿主负责实现适配器，组件以
显式状态机驱动采集过程。

## 适配器协议

- `read()`：返回当前视口的有序行与滚动代数（generation）。同一代数内
  反复读取结果不变；每次列表状态变化（滚动、删除、重排、版本更新）都推进代数。
- `move(anchorId, delta)`：以锚点行相对滚动。组件固定以**当前视口最后一行**
  为锚点、`delta = 1` 调用。
  - 滚动成功返回 `{ kind: "moved", generation }`，新代数必须严格递增；
  - 锚点已被移除时返回 `{ kind: "stale", generation }`，不发生滚动，
    组件重新 `read()` 后再试，stale 不计入稳定轮次。
- 两个方法都可能 reject。`move()` 允许“动作成功但响应丢失”：组件用
  `read()` 确认代数——代数增加说明移动已生效，只能读新视口、**不得重复
  滚动**；代数未变说明未生效，重试同一移动。`read()` 失败一律先停止。

## 行合并规则

- 新 ID：直接采集；
- 同 ID 更高版本：覆盖旧行，视为有进展；
- 同 ID 同版本同内容：无变化；同版本不同内容：协议错误并停止；
- 同 ID 更低版本：忽略，保留已采集的较高版本。

## 终止条件

- 连续 `stableRounds`（K）次**有效移动**后没有新 ID 也没有更高版本：
  `completed`；stale 与初次读取不计入该计数；
- `moveBudget`（正整数）耗尽：`budget-exhausted`，同时返回已采集数据；
- 读取失败：`read-failed`；协议违例：`protocol-error`。

## 用法

```ts
import { collectVirtualList, type VirtualListAdapter } from "./index.js";

const result = await collectVirtualList(adapter, {
  stableRounds: 3,
  moveBudget: 100,
});
// result.status / result.rows / result.generation / result.movesUsed
```

`src/memory-adapter.ts` 提供脚本化内存适配器（重排、删除锚点、upsert、
响应丢失等事件），用于宿主接入前的本地验证。

## 测试

```bash
npm test        # tsc 编译到 dist/ 后用 node:test 运行
npm run typecheck
```

覆盖：顺序滚动与终止边界、移动预算、版本覆盖/同版本冲突、重排、删除锚点
（stale 不计轮次）、move 响应丢失与恢复、读取失败先停止、代数回退等协议违例。
验收不依赖外部网络。
