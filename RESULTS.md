# RESULTS

- 环境：Node.js v22.22.1，仅标准库，测试框架 `node:test`
- 运行时间：2026-10-03T04:29:03Z（UTC）
- 命令：`node --test`

## 汇总（真实输出）

```
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4631.904699
```

4 个测试文件全部通过，共 19 个用例（`node --test` 以文件为顶层计数）：

- test/store.test.js — 9 个用例全部通过
- test/crash.test.js — 5 个用例全部通过
- test/cli.test.js — 5 个用例全部通过
- test/helpers.js — 纯辅助模块，无用例

## 验收对照

1. **幂等**：`duplicate clientRecordId produces one state entry and one certificate`、
   `CLI duplicate report exits 0 with duplicate flag and single certificate` ——
   两次相同 `clientRecordId` 上报只产生一条状态记录和一个证书，WAL 不追加。
2. **更正**：`correction OK -> NG updates judgment, index and chain; old cert still verifies`、
   `CLI correction flow updates status and keeps old cert verifiable` ——
   合格更正为不合格后，最新判定、(lotId, testCode) 索引与证书链同步更新；
   旧证书 `verify --id rec-00000001` 仍可独立验证。
3. **崩溃恢复**：`crash after data sync: uncommitted record produces no judgment on recovery`、
   `crash after commit marker sync: committed record survives recovery`、
   `interleaved crashes at both fault points converge to reference replay` ——
   两类故障点（数据 sync 后、commit 标记 sync 后）注入后恢复，
   恢复状态与朴素“按序列号重放有效提交记录”的参考实现 `referenceReplay` 深度一致。

## 备注

- 沙箱环境禁止测试进程 spawn 子进程，CLI 端到端测试通过进程内调用
  `runCli(argv, io)`（`src/cli.js`，与 `bin/qms.js` 同一入口逻辑）断言 stdout/stderr 与退出码。
- 损坏检测（garbage 行、撕裂写、哈希链断裂）均按 exit 2 处理并有测试覆盖。
