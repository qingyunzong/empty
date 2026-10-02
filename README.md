# incremental-recompute

实验参数扫描的增量复现库及 CLI。Node.js 22，仅标准库，全程离线。

## 模型

- 每个任务声明：`input`（输入哈希）、`version`（模块版本）、`deps`（前驱任务 id 列表）。
- 结果哈希 = SHA-256(规范JSON({ deps: [[前驱id, 前驱结果哈希]...按id升序], input, version }))。
  规范 JSON：对象键按字典序排列、无空白、数组保序。
- 事务（原子）：`setInput`（更正参数）、`setVersion`（替换模块版本）、
  `addDeps` / `removeDeps`（增删依赖），可组合在一个事务中。
- 动态拓扑排序：分层 Kahn，同层按 id 升序；仅重算失效闭包
  （规格变化的任务及其全部传递后继），每个任务恰好一次。
- 输出：`recomputed`（重算顺序）、`diff`（新旧哈希）、`stopPoints`
  （重算波停止的前沿：闭包内无后继仍在闭包中的任务）、`hashes`（全量新哈希）。
- `maxRecompute` 预算：失效闭包大小超过预算返回 `E_BUDGET`，整个事务回滚。
- 环（含自环）返回 `E_CYCLE` 并回滚；未知任务返回 `E_UNKNOWN_TASK`。
- 无变化事务返回 `ok: true` 与空的重算结果。

## 库用法

```js
import { initState, applyTransaction } from './src/engine.js';

const init = initState({
  a: { input: 'i', version: 'v1', deps: [] },
  b: { input: 'i', version: 'v1', deps: ['a'] },
});
const result = applyTransaction(init.state, { setVersion: { a: 'v2' } }, { maxRecompute: 10 });
```

## CLI

从 stdin 读 JSON 请求，向 stdout 写 JSON 结果：

```sh
echo '{"tasks":{"a":{"input":"i","version":"v1","deps":[]}},"transaction":{"setInput":{"a":"j"}},"maxRecompute":5}' | node src/cli.js
```

请求字段：`tasks`、`transaction`、`maxRecompute`（可选，默认无限）。

## 测试

```sh
node --test > test-results.txt 2>&1
```

- `test/engine.test.js`：≤9 任务的随机图枚举（300 例，种子固定）与全图清空重算参考
  对比最终哈希、失效集合与重算顺序；菱形/多分支合并只重算一次且顺序固定；
  超预算、成环、自环、无变化事务及回滚。
- `test/cli.test.js`：CLI 经 stdin/stdout 的端到端行为。
