# RESULT

## 环境

- Node.js: v22.22.1（`node --version` 实测）
- 依赖：仅标准库（`node:test` / `node:crypto` / `node:fs` / `node:path`）
- 运行方式：单机离线，`node --test`

## 测试运行（真实输出）

命令：`node --test`，执行时间 2026-10-04T00:54:34Z（UTC）

```
ok 1 - test/acceptance.test.js
ok 2 - test/cli.test.js
ok 3 - test/helpers.js
ok 4 - test/state.test.js
# tests 4
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

逐文件子测试统计（`node <file>` 实测）：

| 文件 | 子测试通过 |
|------|-----------|
| test/acceptance.test.js | 5 / 5 |
| test/state.test.js | 10 / 10 |
| test/cli.test.js | 6 / 6 |
| 合计 | 21 / 21 |

退出码：`node --test` 返回 0。

## 验收标准覆盖

- **A 三班倒跨午夜**：`test/acceptance.test.js`「A: three-shift rotation
  crossing midnight」——夜班 22:00→次日 06:00，22:30 开工的 8 小时工单
  结束于次日 06:30，`crossesMidnight: true`。
- **B 撤销冻结后物料锁恢复**：「B: revoke freeze restores material locks,
  history untouched」——放行消耗锁 → 冻结生成补偿事件并归还库存 → 主管
  撤销冻结后锁恢复；输入事件日志全程不被改写（断言深比较）。
- **C 并发同刻事件确定性 tie-break**：「C: same-instant release/freeze
  resolves deterministically, freeze wins」——同刻同级冻结胜，与文件内
  先后顺序无关；同一日志重放两次状态哈希一致。
- **D 随机 100 事件与暴力重放对照**：「D: 100 random events - incremental
  snapshots match brute-force replay」——固定种子随机 100 事件，逐事件
  快照与前缀暴力重放哈希一致；从任意事件号（0/1/23/42/63/88/99）续放
  与完整重放的规范化状态完全一致。

## 错误退出码验证

- 时间倒退 exit 5：`test/state.test.js`（库层 2 例）+ `test/cli.test.js`（CLI 1 例）
- 能力负数 exit 6：`test/state.test.js` + `test/cli.test.js`
- 未知物料 exit 7：`test/state.test.js` + `test/cli.test.js`

## 备注

- 本环境沙箱禁止从 Node 派生子进程（`spawnSync` EPERM），故 CLI 测试通过
  `src/cli.js` 的 `runCli(argv, io)` 进程内调用并断言返回码；
  `bin/gate.js` 为薄封装（`process.exitCode = runCli(process.argv.slice(2))`），
  真实 CLI 已在 shell 中对 `examples/` 数据手动验证：
  `run` 生成 `schedule.out.json` / `breach.json` / `compensation.jsonl`，
  `replay --from 3` 的状态哈希与完整运行一致
  （`777e6e44…b51b580aeafa75a663f408f`）。
