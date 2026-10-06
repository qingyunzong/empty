# exec-planner

执行规划库：只接受结构化动作清单，输出带证据的有序计划；任何单字段篡改都会导致核对失败，且核对失败不产生任何副作用。

- 运行时零依赖，仅使用 Node.js 内置模块（`node:crypto`、`node:test`、`node:assert`）
- TypeScript 严格模式编译（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）

## 行为契约

1. **只接受结构化动作清单**：输入必须是 `{ resources, actions }` 对象。说明性文本（散文、markdown、混入的自然语言条目）一律以 `UNSTRUCTURED_INPUT` / `UNSTRUCTURED_ACTION` 拒绝，绝不解析成动作。
2. **引用输入资源 ID**：每个 action 通过 `inputs: string[]` 引用资源；引用未知 ID 时全批拒绝（`UNKNOWN_RESOURCE`）。
3. **摘要校验全批拒绝**：每个资源携带 `sha256:<hex>` 内容摘要；任一资源摘要与其内容不匹配，整批拒绝（`DIGEST_MISMATCH`），不产出任何计划。
4. **有序计划 + 证据**：计划步骤带序号，逐步计算 `stepHash` 并链接成 `chainHash`；证据（`Evidence`）绑定计划 ID、全部资源摘要、步骤哈希链与根哈希。
5. **篡改检测**：`verifyPlan` 纯函数式重算全部摘要与哈希；篡改任一字段（资源内容、摘要、action 参数、步骤顺序、证据哈希）均返回 `{ ok: false }`。
6. **无副作用**：`executePlan` 先核对再执行；核对失败时不调用任何 handler，返回 `{ executed: false, reason }`。

## API

```ts
import { createPlan, verifyPlan, executePlan, digestContent } from "exec-planner";

const resources = [{ id: "cfg", content: "mode=fast", digest: digestContent("mode=fast") }];
const { plan, evidence } = createPlan({
  resources,
  actions: [{ id: "a1", kind: "load", inputs: ["cfg"] }],
});

verifyPlan(plan, evidence, resources); // { ok: true }

executePlan(plan, evidence, resources, {
  load: (step, byId) => { /* ... */ },
});
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

### 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

```
$ npm test
> tsc -p tsconfig.json && node --test dist/test/*.test.js
# tests 22
# suites 4
# pass 22
# fail 0
# duration_ms ~1000
```

22/22 通过，覆盖：

- `createPlan` 结构化输入：接受合法清单并产出有序计划与证据；确定性（同输入同哈希）；拒绝散文输入、文本条目、混入文本、多余字段
- 摘要与引用校验：单资源摘要不匹配全批拒绝、内容篡改留旧摘要、未知资源引用、非法摘要格式、重复资源 ID
- `verifyPlan` 篡改检测：资源内容/摘要、action 参数/kind、步骤顺序、证据步骤哈希、证据根哈希、资源缺失
- `executePlan` 副作用门控：合法计划按序执行；单字段篡改后 0 个 handler 被调用

## 结构

```
src/canonical.ts   规范化 JSON（键排序、无空白），一切哈希的基础
src/digest.ts      sha256 摘要工具
src/types.ts       Resource / Action / Plan / Evidence 类型
src/planner.ts     createPlan：校验 + 有序计划 + 证据生成
src/verify.ts      verifyPlan：纯函数重算核对
src/execute.ts     executePlan：核对门控执行
test/planner.test.ts  22 个测试（node:test）
types/node-builtins.d.ts  零依赖所需的最小内置模块类型声明
```
