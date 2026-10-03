# batch-lineage

制造批次谱系库 + 单机离线 CLI。Node.js 22,仅标准库与 `node:test`,无第三方依赖。

## 模型

- 批次:`{id, weight, qc, parents[], children[]}`,父子边带 `amount`,构成双向二级索引。
- 父批次可拆分(split)为多个子批次;多个父批次可合并(merge)为一个子批次;`link` 可在既有批次间补建有向边。
- 重量守恒:任一批次的子边 `amount` 之和不得超过其自身重量(有效父批次重量 = 重量 − 已分配)。merge 按父批次顺序从剩余量中扣减。
- 禁止循环祖先:加边前对子节点做后代 DFS,命中父节点即拒绝;自环同样拒绝。
- 质检状态:`pending | passed | failed`。

## 事务与保存点

- 单顶层事务;`savepoint(name)` / `release(name)` / `rollback(name)` 支持嵌套。
- `release` 只释放该保存点及其后的边界,不撤销任何修改。
- `rollback` 撤销该保存点之后的全部拆分、索引与状态变更;按 SQL 语义该保存点本身保留。
- 提交后生成 SHA256 谱系证书(规范 JSON 序列化 + prevHash 链),写入 `certificates/`。

## WAL 与恢复

- 每个操作先落 `wal.log`(逐行 JSON + SHA256 校验和),提交时追加 `commit` 标记并 fsync,然后原子重写 `state.json`(tmp+rename)、写证书、截断 WAL。
- 恢复:重放 WAL。无 commit 标记 → 暂定修改全部丢弃不可见;有 commit 标记 → 重做并重建索引与证书。WAL 末尾撕裂行按崩溃截断处理;中间校验和失败或 `state.json` 校验失败 → 损坏错误。

## CLI

```
node bin/cli.js <dir> <create|split|merge|link|qc|lineage|certificate|verify|state> '<json-args>'
```

输出为单行 JSON;业务错误 exit 1,损坏错误 exit 2。

```sh
node bin/cli.js data create '{"id":"P","weight":100}'
node bin/cli.js data split  '{"parent":"P","children":[{"id":"A","weight":30},{"id":"B","weight":40}]}'
node bin/cli.js data merge  '{"parents":["A","B"],"child":{"id":"M","weight":50}}'
node bin/cli.js data qc     '{"id":"M","status":"passed"}'
node bin/cli.js data lineage '{"id":"M"}'
node bin/cli.js data verify
```

## 测试

`node --test`。验收覆盖:

1. `test/savepoint.test.js` — 内层拆分回滚后父批次重量与子索引恢复,外层修改保留;release 只释放边界。
2. `test/crash.test.js` — 提交标记前崩溃 → 重启无部分批次;标记后崩溃 → 重做后谱系与索引完整。
3. `test/enumerate.test.js` — 枚举 ≤4 个保存点操作的全部 1554 条序列,与递归 DFS 参考实现(`src/reference.js`)对照重量、祖先与证书哈希。
4. `test/conservation.test.js` — 重量守恒、合并上限、循环祖先禁止、证书哈希链。
5. `test/cli.test.js` — JSON 输出与退出码(业务 1 / 损坏 2)。沙箱禁止 spawn,CLI 入口函数在进程内驱动,`bin/cli.js` 为同一函数的薄包装。
