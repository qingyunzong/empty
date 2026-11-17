# Embeddable Memo Query Optimizer

零依赖、可嵌入的 TypeScript Cascades 风格 memo 优化器组件。

## 能力

- **等价分组（Memo）**：逻辑表达式按结构 intern 到 group，转换规则通过
  union-find 合并等价 group（`src/memo.ts`）。
- **逻辑探索规则**：Select 谓词下推、InnerJoin 交换律与结合律，工作队列迭代到
  不动点（`src/rules.ts`）。列归属通过显式映射或 `relation_column` 前缀约定解析。
- **物理属性传播**：每个物理实现声明对子节点的属性需求与自身交付属性，
  Sort/Exchange enforcer 补齐缺口（`src/physical.ts`）。
- **分支限界**：可加代价模型，运行期 incumbent 上界即时剪枝；并列代价按规范化
  指纹的字典序稳定决胜（`src/optimizer.ts`、`src/fingerprint.ts`）。
- **相关性安全**：group 以 `CorrCtx`（pathId + 外层参数集合）为作用域，跨上下文
  合并直接抛错；相关 `Select(Get)` 可重写为 `ParamIndexScan`。
- **穷举验证器**：不剪枝枚举整个（小）计划空间，独立校验胜者满足属性且代价全局
  最小（`src/verifier.ts`）。

## 用法

```ts
import {
  buildMemo,
  optimize,
  verifyWinner,
  createCostModel,
  type LogicalTree,
  type PhysicalProps,
} from './src/index.ts';

const required: PhysicalProps = { order: null, distribution: null };
const built = buildMemo(tree, columnOwners);
const result = optimize({
  memo: built.memo,
  rootGroup: built.rootGroup,
  required,
  stats,
  costModel: createCostModel(),
});

// 独立穷举验证：属性满足 + 全局最小 + 指纹决胜
const verdict = verifyWinner(
  { memo: built.memo, rootGroup: built.rootGroup, required, stats, costModel },
  { plan: result.plan, cost: result.cost },
);
```

也可以使用一站式入口 `optimizeQuery` 与 `optimizeAndVerify`。

## 测试

```bash
npm test   # tsc 编译到 build/ 后运行 node:test
```

测试覆盖 memo 等价分组、规则探索、物理属性/enforcer、相关子查询隔离、参数化索引
扫描、指纹并列决胜，以及对每个小查询形状的穷举全局最优性校验。
