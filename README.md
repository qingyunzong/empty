# 质量批次谱系追溯（单机离线）

Node.js 22 标准库实现，无外部依赖。谱系边为 `{child, parent, quantity}`，
检验记录为 `{lot, result: pass|block|null, ts}`；`null` 或缺失记录一律视为未检，
绝不隐式判定合格。

## 语义

- 上游/下游闭包由递归关系代数计算（`src/lineage.js`），`src/reference.js`
  提供独立的迭代 DFS 参考实现用于交叉核对。
- 批次 blocked 当且仅当自身或任一上游存在 block 记录。
- 证书状态：有 block → `blocked`；闭包内存在未检批次 → `uninspected`；全部 pass → `passed`。
- 证书包含根集合、叶集合、阻塞记录集合与输入哈希（边+检验的规范化 SHA-256）。
- 更正以事务提交（`commit`），产生新谱系版本；`undo <txId>` 精确逆放更正，
  恢复原闭包与阻塞集合；撤销不存在的事务报错，重复撤销幂等。

## 用法

```sh
node src/cli.js [--db trace-db.json] commit '{"id":"tx1","corrections":[...]}'
node src/cli.js [--db trace-db.json] trace <lot>
node src/cli.js [--db trace-db.json] undo <txId>
```

更正项：`{"kind":"edge","old":…|null,"new":…|null}` 或
`{"kind":"inspection","old":…|null,"new":…|null}`（`null` 表示新增/删除）。

## 测试

```sh
node --test
```
