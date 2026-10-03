# crash-ledger

可崩溃的额度冻结账本库与 CLI（Node.js 22 标准库，无依赖）。

## 事件日志

事件以 JSON Lines 顺序追加，每行字段：`seq`、`eventId`、`type`、`account`、`amount`、`prevHash`、`hash`。
`hash = sha256(JSON.stringify({seq, eventId, type, account, amount, prevHash}))`，首条 `prevHash` 为 64 个 `0`。
每个 `eventId` 幂等：重复提交返回 `{applied: false, reason: 'duplicate eventId'}`，不产生重复扣款。

## 语义

- `reserve`：持有增加、可用减少（可用 = 额度 - 持有 - 已 commit）；账户冻结后拒绝。
- `commit`：扣减持有并永久扣减额度。
- `release`：仅释放未 commit 的持有，返还可用。
- `freeze`：冻结账户，拒绝后续新增 `reserve`（`commit`/`release` 仍允许）。

## 故障点

仅允许 `beforeAppend` 与 `afterAppend` 两个故障点：

- `beforeAppend`：崩溃后事件不存在，文件无任何部分写入（CLI 退出码 1）。
- `afterAppend`：事件已写入并 fsync 后崩溃（CLI 退出码 42），重启后事件保留。

## 恢复

打开账本时从头校验链式哈希（JSON、字段、seq 连续、prevHash 链接、hash 一致、eventId 唯一），
遇到首条损坏记录即 `fs.truncate` 截断该记录及后续内容，再重放得到有效状态。
恢复报告：`{truncated, offset, line, reason, validEvents, headHash}`。

## CLI

```
node cli.js state   <file> [--limit N]
node cli.js reserve <file> <account> <amount> [--event-id ID] [--limit N] [--crash beforeAppend|afterAppend]
node cli.js commit  <file> <account> <amount> [--event-id ID] [--limit N] [--crash ...]
node cli.js release <file> <account> <amount> [--event-id ID] [--limit N] [--crash ...]
node cli.js freeze  <file> <account>          [--event-id ID] [--limit N] [--crash ...]
```

退出码：0 成功；1 beforeAppend 崩溃（事件未持久化）；42 afterAppend 崩溃（事件已持久化）；2 用法错误/事件被拒绝。

## 测试

```
node --test 2>&1 | tee test-result.txt
```

- `test/acceptance.test.js`：三条验收场景（真实子进程、真实退出码）。
- `test/model.test.js`：对 ≤5 个事件的全部操作序列（4 种操作，共 1364 条序列、约 2 万场景），
  在每个故障点崩溃后与独立顺序参考模型逐状态对照。
- `scripts/acceptance-demo.js`：打印三场景的恢复报告与哈希，输出已记录于 `test-result.txt`。
