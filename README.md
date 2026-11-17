# SQL 逻辑优化器规则调度组件

一个可嵌入的 TypeScript e-graph 风格重写调度器。它维护表达式等价类、匹配指纹和匹配依赖，只重扫被规则或并类影响的类。

## 核心不变量

- 等价类使用并查集与同余闭包（congruence closure）维护；同一 `op + value + 子类` 的 e-node 会 hashcons 去重。
- 每条规则匹配以 `规则 id + 根类 + e-node key + 变量绑定` 生成指纹。同一指纹最多执行一次，循环交换律不会重复爆炸。
- 每个已执行匹配登记其访问过的类。并类时只失效依赖这些类的匹配，并把获胜类及其父类重新入队。
- 规则输出与匹配根类合并，因此规则应当是单调的等价重写；不支持从图中删除等价关系。
- 新增的独立表达式只扫描新类及其受影响父类，不会全图重扫。

## 用法

```ts
import {
  RuleScheduler,
  expr,
  pattern,
  v,
} from "./index.ts";

const x = v("x");
const y = v("y");

const scheduler = new RuleScheduler({
  rules: [
    {
      id: "and-commute",
      pattern: pattern("and", [x, y]),
      replacement: pattern("and", [y, x]),
    },
    {
      id: "and-idempotent",
      pattern: pattern("and", [x, x]),
      replacement: x,
    },
  ],
});

const a = scheduler.add(expr("a"));
const root = scheduler.add(expr("and", [expr("a"), expr("a")]));

const stats = scheduler.run();
console.log(stats.status);                     // "fixpoint"
console.log(scheduler.areEquivalent(root, a)); // true
console.log(scheduler.nodesInClass(root));     // 等价类内的 e-node
```

`value` 可携带字面量等标量/JSON 值；对象键在哈希前会稳定排序。模式中的 `v("x")` 可同时用于匹配和替换模板。

## 增量与全量对照

`verifyAgainstFullRescan` 用相同种子和规则分别运行增量调度与全量重扫，并通过与类 id 无关的结构签名比较最终等价集合：

```ts
import { verifyAgainstFullRescan } from "./index.ts";

const comparison = verifyAgainstFullRescan(seeds, rules);
if (!comparison.equal) {
  console.error(comparison.incrementalSignature);
  console.error(comparison.fullRescanSignature);
}
```

测试在有限布尔代数上枚举 720 个根表达式，覆盖交换、幂等、吸收、双重否定和 De Morgan 循环规则，逐个断言增量结果与全量重扫完全一致。

## 诊断

- `scheduler.stats`：本轮扫描类数、发现/执行/跳过/失效匹配数、并类与新节点数。
- `scheduler.pendingClassCount`：尚未处理的受影响类数。
- `scheduler.fingerprintCount`：已登记匹配指纹数。
- `scheduler.activeMatchCount`：仍登记失效依赖的匹配数。
- `scheduler.validate()`：检查 hashcons、类成员和子节点反向索引的一致性。

`maxIterations` 与 `maxNodes` 提供硬预算；超过时状态为 `iteration-limit` 或 `node-limit`，不会静默截断。

## 开发

```bash
npm test
```

测试会先用 `tsc` 做严格类型检查并输出到 `.test-build/`，再用 Node 测试运行器执行。
