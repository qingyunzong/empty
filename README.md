# incremental-recompute

实验参数扫描的增量复现库及 CLI。Node.js 22,仅标准库与 `node:test`,全程离线。

## 模型

- 每个任务声明:`id`、`inputHash`(输入哈希)、`moduleVersion`(模块版本)、`deps`(前驱任务 id 列表)。
- 结果哈希 = `sha256(canonicalJSON({ deps: [{id, hash}...按 id 升序], inputHash, moduleVersion }))`,
  即由前驱结果哈希、输入哈希、模块版本经规范 JSON(键递归排序、无空白)串行化后取哈希。

## 事务

一个事务携带 `maxRecompute` 预算与一组 ops,原子生效:

- `setModuleVersion` / `setInput`:替换模块版本、更正参数
- `addDep` / `removeDep`:增删依赖
- `addTask` / `removeTask`:增删任务(删除有依赖者的任务返回 `E_HAS_DEPENDENTS`)

事务流程:应用 ops → 环检测(含自环,`E_CYCLE`)→ 计算失效闭包(声明变更任务 + 传递后继)
→ 闭包大小超过 `maxRecompute` 返回 `E_BUDGET` 并整体回滚 → 动态拓扑排序
(按层推进,同层按 id 升序)→ 仅重算失效闭包。

成功结果:`{ ok, noop, invalidated, changes: [{id, oldHash, newHash}], stopPoints }`。
`stopPoints` 为重算后哈希未变的任务,即变更影响停止传播的位置。
无变化事务返回 `ok: true, noop: true` 且各列表为空。

## CLI

从 stdin 读一个 JSON 请求,向 stdout 写一个 JSON 响应:

```sh
echo '{"tasks":[{"id":"a","inputHash":"i","moduleVersion":"m1"}],
       "transactions":[{"maxRecompute":4,"ops":[{"type":"setInput","task":"a","inputHash":"i2"}]}]}' \
  | node src/cli.js
```

请求格式:`{ "tasks": [...], "transactions": [{ "maxRecompute": N, "ops": [...] }] }`;
裸的 `{ "ops": [...] }` 视为单个事务。响应:`{ "ok": true, "results": [...] }`。

## 测试

```sh
node --test > test-results.txt 2>&1
```

- `test/property.test.js`:≤9 任务、400 个随机种子,与"全图清空重算"参考实现
  (`test-utils/reference.js`)逐位比较最终哈希与失效集合,并验证超预算回滚。
- `test/store.test.js`:菱形汇合只重算一次且顺序固定;超预算 `E_BUDGET`、
  成环/自环 `E_CYCLE`、无变化 noop;依赖重连等。
- `test/cli.test.js`:CLI 请求处理路径(多事务顺序、裸事务、坏 JSON)。
