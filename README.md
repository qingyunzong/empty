# delivery-plan-engine

确定性交付调度引擎。TypeScript 编写，运行时仅使用 Node.js 内置库
（`node:crypto`、`node:test`、`node:assert`），零第三方依赖。

## 规则

- **候选条件**：事件成为候选当且仅当其全部依赖已交付（依赖全满足）。
- **候选间排序**：优先级高者优先；优先级相同则 ID 小者优先
  （纯数字 ID 按数值比较，否则按字典序）。
- **因果约束**：优先级只在当前候选集合内起作用，高优先级事件
  不能越过未满足的因果依赖先交付。
- **取消语义**：被取消的事件永不交付；其直接/传递后继全部进入
  阻塞状态；取消事件的元数据完整保留在 `cancelled` 记录中。

## 输出

`buildDeliveryPlan(events, cancelledIds)` 返回 `DeliveryPlan`：

- `order` / `certificates`：交付顺序与交付证书。证书含
  `seq`、`eventId`、`priority`、`satisfiedDeps`、`meta`，以及对上述
  内容（键序稳定序列化）的 SHA-256 `digest`。
- `blocked` / `blockingChains`：阻塞事件及其阻塞链。链从被阻塞事件
  出发，沿依赖边回溯到被取消的根事件（BFS 最短链，邻居按 ID 排序，
  结果确定）。
- `cancelled`：取消记录，保留 `priority`、`deps`、`meta`。

## 使用

```bash
npm test        # tsc 编译 + node --test 运行全部测试
npm run demo    # 打印一份示例交付计划（含阻塞链与证书）
```

```ts
import { buildDeliveryPlan } from "./src/engine.js";

const plan = buildDeliveryPlan(
  [
    { id: "ingest", priority: 1 },
    { id: "publish", priority: 9, deps: ["ingest"] },
    { id: "billing", priority: 2, meta: { owner: "finance" } },
    { id: "invoice", priority: 8, deps: ["billing"] },
  ],
  ["billing"],
);
// plan.order        -> ["ingest", "publish"]
// plan.blocked      -> ["invoice"]
// plan.blockingChains -> [{ eventId: "invoice", chain: ["invoice", "billing"], ... }]
// plan.cancelled[0].meta -> { owner: "finance" }（元数据保留）
```

## 小 DAG 穷举核对

`src/verify.ts` 的 `enumerateAndCheck(n)` 枚举 n 个节点上的全部
2^(n(n-1)/2) 个带标号 DAG，并枚举优先级赋值与取消子集，对每个实例
独立重算并核对：

1. 阻塞集 == 取消事件的反向可达集；
2. 每一步交付事件 == 当前候选集中（优先级高、ID 小）的唯一最优者
   （即交付序是合法拓扑序且高优先级未越因果）；
3. 证书的 `seq`、依赖、`digest` 全部可重算一致；
4. 阻塞链结构合法：相邻元素存在依赖边、根为取消事件、中间节点均被阻塞；
5. 取消记录元数据与输入完全一致。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 实际运行结果：

```
# Subtest: dist/test/engine.test.js        ok  (8 个用例，~324ms)
# Subtest: dist/test/enumeration.test.js   ok  (~13.6s)
# tests 2 / pass 2 / fail 0
# duration_ms ~13684–17632，npm test 总耗时约 15–19s
```

穷举规模：

- n=4：64 个 DAG × 3^4 种优先级 × 2^4 种取消集 = **82,944** 个实例，0 失败；
- n=5：1024 个 DAG × 2^5 种优先级 × 取消大小 ≤1 的 6 种子集 =
  **196,608** 个实例，0 失败。

（n=5 取消大小 ≤2 的全量 524,288 实例亦验证通过，耗时约 36s，
为控制 `npm test` 时长未纳入默认测试。）

## 文件结构

- `src/engine.ts`：核心引擎（校验、拓扑检查、贪心调度、阻塞链、证书）。
- `src/verify.ts`：小 DAG 穷举核对器。
- `src/demo.ts`：示例，输出完整交付计划 JSON。
- `test/engine.test.ts`：单元测试（排序规则、因果约束、取消语义、
  证书摘要、错误输入）。
- `test/enumeration.test.ts`：穷举核对测试。
- `types/node-shims.d.ts`：所用 Node 内置模块的最小类型声明。
