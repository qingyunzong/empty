# exec-planner

执行规划库：只接受结构化动作清单，全批校验（all-or-nothing），输出有序计划与证据。
纯 TypeScript + Node.js 内置库（`node:crypto`、`node:test`、`node:assert`），零外部依赖。

## 行为约定

- **只接受结构化动作清单**：`actions` 必须是对象数组，每个动作含 `kind`（枚举：
  `fetch` / `transform` / `aggregate` / `emit`）与 `inputs`（非空资源 ID 字符串数组）。
  说明性文本（字符串、散文）一律拒绝，绝不解析成动作。
- **引用输入资源 ID**：动作的 `inputs` 必须引用 `resources` 中已声明的资源 ID，
  引用未声明 ID 即拒绝。
- **任一来源摘要不匹配全批拒绝**：每个资源携带 `content` 与声明的 `digest`
  （sha256 hex）。规划器重算摘要并做常量时间比较；任何一个资源不匹配，
  整批拒绝并汇总全部问题，不产生部分计划。
- **输出依赖有序计划及证据**：成功时返回 `Plan`，含按提交顺序编号（`seq`）的
  `steps`、逐资源的 `evidence`（声明摘要 / 实算摘要 / 校验位），以及由
  `{steps, evidence}` 稳定序列化后求 sha256 得到的 `planDigest`——
  动作顺序变化会改变 `planDigest`。
- **核对失败不产生副作用**：`createPlan` 在失败时抛出 `PlanRejection`，
  不调用 `emit` 回调、不改动入参；`emit` 仅在整批验收通过后恰好调用一次。

## API

```ts
import { createPlan, sha256Hex, PlanRejection } from "exec-planner";

const plan = createPlan(
  {
    resources: [
      { id: "raw-orders", content: "order-id,amount\n1,10\n", digest: sha256Hex("order-id,amount\n1,10\n") },
    ],
    actions: [{ kind: "fetch", inputs: ["raw-orders"] }],
  },
  (p) => { /* emit 副作用：仅在验收通过后触发一次 */ },
);
// plan.steps / plan.evidence / plan.planDigest
```

## 测试

```
npm test        # tsc 编译 + node --test
npm run typecheck
```

## 实测结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 实际运行输出（TAP 汇总）：

```
# tests 9
# suites 3
# pass 9
# fail 0
# duration_ms 570.886155
```

3 个套件全部通过：

- `structured input only`：合法批次产生有序计划与证据；顺序影响 `planDigest`；
  散文条目、非数组 `actions`、未知 `kind`、未声明资源引用均被拒绝。
- `digest verification is all-or-nothing`：单个摘要篡改即整批拒绝；多处不匹配一次性汇总报告。
- `tamper resistance`：500 轮随机单字段篡改（摘要翻位、内容污染、非法 kind、
  幽灵资源引用、散文替换动作等）全部核对失败，`emit` 计数恒为 0；
  未篡改请求恰好触发 1 次；失败核对不改动调用方入参。
