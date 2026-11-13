# 任务重试预算继承

数据编排器需要可导入的 TypeScript 重试预算组件，预算可在工作流、任务族和实例三级共享，错误分类决定是否消费。子任务拆分继承同一父预算，取消不计失败；并发失败原子扣减，最后一个名额只能授予一次。每次决定返回剩余量与规则证据。

## 用法

```ts
import { RetryBudget, RetryBudgetRegistry } from './index.js';

// 三级共享：instance -> family -> workflow 逐级回退解析
const registry = new RetryBudgetRegistry();
registry.setWorkflowBudget('wf-1', 10);
registry.setFamilyBudget('wf-1', 'extract', 3);
registry.setInstanceBudget('wf-1', 'extract', 'shard-9', 1);

const { budget, evidence } = registry.resolve({
  workflowId: 'wf-1',
  family: 'extract',
  instanceId: 'shard-9',
});

// 子任务拆分：fork 共享同一父预算计数器
const child = budget.fork('shard-9a');

// 错误分类决定是否消费预算；取消（AbortError）不计失败
const decision = child.recordFailure(error);
// decision: { allowed, consumed, remaining, limit, category, scope, budgetName, evidence }
```

- `RetryBudget.recordFailure(error)` 同步完成“检查 + 扣减”，同一事件循环内的并发失败串行化，最后一个名额只会授予一次。
- 每次决定返回 `remaining` 与 `evidence`（作用域解析、错误分类、扣减/拒绝所依据的规则）。
- 默认分类器：`cancelled` / `permanent` 不重试且不消费；`transient` / `rate-limited` / `unknown` 消费预算。可通过 `classifier` 选项注入自定义规则。

## 脚本

- `npm run typecheck` — 严格类型检查（`tsc --noEmit`）
- `npm test` — 编译到 `build/` 并运行 `node --test`
