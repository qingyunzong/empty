# txn-tree-undo

交易树有序近邻查询与批量撤销。仅依赖 Node.js 22 标准库，单机离线运行。

## 数据模型

节点：`{ id, parentId, amount, reason, state }`，`state` 为 `active` 或 `undone`。

## 近邻查询语义

- `reason` 按空白分词并小写化，词位置从 0 开始。
- 短语对 `[t1, t2]` 的有序近邻匹配：存在位置 `p1 < p2` 且中间词数 `p2 - p1 - 1 <= slop`。
  `slop = 0` 表示严格相邻；逆序不匹配。
- 位置索引：`byTerm`（词 → 节点/位置倒排）+ `byNode`（节点 → 词 → 位置），
  查询限定在指定根的子树范围内，命中按节点 id 字典序返回。

## 撤销命令

`undo(dir, { rootId, phrase, slop, budget })`：

1. 根不存在 → `ROOT_NOT_FOUND`；任一父链成环 → `CYCLE_DETECTED`。
2. 在根子树内做近邻查询，命中按节点 id 字典序处理。
3. 撤销集 = 全部命中节点及其各自后代（去重），结果集完整确定。
4. 撤销集中任一节点已撤销 → `ALREADY_UNDONE`。
5. 撤销集总金额 > 预算 → `BUDGET_EXCEEDED`（等于预算可通过）。
6. 以上任一失败均无副作用（不写任何状态文件）。
7. 成功则生成补偿批次号（`BATCH-000001` 递增）与证书：批次号、根、短语、
   slop、预算、总金额，以及每个节点的 id、层级（距森林根深度）、金额、
   查询命中位置（直接命中）或空位置（随祖先连带撤销）。

返回 `{ ok: true, batchId, certificate }` 或 `{ ok: false, error: { code, message } }`。

## 持久化与原子性

状态目录布局：

```
<dir>/nodes.json            基础节点快照（tmp 写入 + fsync + rename 原子替换）
<dir>/batches/000001.json   批次记录（证书），原子写入
<dir>/batches/000001.commit 提交标记，在批次文件 rename 之后写入
```

加载时只应用带提交标记的批次；批次文件存在但标记缺失（崩溃窗口）时，
重启后视为未撤销，该序号会被后续撤销复用并覆盖。游离的 `*.tmp-*` 文件一律忽略。

## 库 API

- `src/core.js`：`tokenize` / `buildPositionalIndex` / `findNearHits` /
  `enumerateOrderedWindows`（参考枚举实现）/ `buildForest` / `planUndo` 等纯函数。
- `src/store.js`：`initStore` / `loadStore` / `listCommittedBatches` / `query` / `undo`。
- `src/cli.js`：`runCli(argv) → { code, stdout, stderr }`，可进程内调用。

## CLI

```
node cli.js init   --dir <stateDir> --nodes <nodes.json>
node cli.js query  --dir <stateDir> --root <id> --phrase "a b" [--slop N]
node cli.js undo   --dir <stateDir> --root <id> --phrase "a b" [--slop N] --budget N
node cli.js status --dir <stateDir>
```

成功退出码 0，JSON 输出到 stdout；业务错误退出码 1，错误 JSON 到 stderr；
未知命令退出码 2。

## 测试

`node --test`（或 `npm test`）。覆盖：

1. 索引近邻命中与枚举 reason 全部有序窗口的参考实现逐位置一致
   （25 个随机种子 × 多根 × 多 slop × 多短语对）。
2. 预算充足时父子一起撤销、金额与证书正确；预算恰好等于总额可通过。
3. 预算不足（`BUDGET_EXCEEDED`）、父链成环（`CYCLE_DETECTED`）、
   重复撤销（`ALREADY_UNDONE`）、根缺失（`ROOT_NOT_FOUND`）均无副作用。
4. 提交标记缺失时重启视为未撤销；游离 tmp/未提交批次文件被忽略；
   原子写不留残余；多批次按序应用。
5. CLI 各子命令与退出码。
