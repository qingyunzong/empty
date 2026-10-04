# netting-ledger

多边净额结算轧账库与 CLI。仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

参与者提交收付条目（`entryId`、`payer`、`payee`、`amount`、`status`），可取消未轧账
条目，并对全部 pending 条目执行多边净额结算（netting）。进程在指定故障点崩溃后，
已确认的结果不丢失、不重复。

## 布局

- `src/ledger.js` — 纯领域逻辑：submit / cancel / settle、净额计算、规范化哈希。
- `src/store.js` — 持久化与恢复：变更日志、快照、durableWatermark、崩溃点注入。
- `src/recovery-report.js` — 测试辅助：把恢复哈希写入 `node --test` 的输出流。
- `cli.js` — 命令行入口。
- `test/` — `node:test` 测试（单元、CLI 子进程崩溃、全枚举对照）。

## CLI

```sh
node cli.js run <ledger.json> [--crash EVENT:POINT]
node cli.js recover <ledger.json>
```

`ledger.json` 是操作脚本：`{"ops": [...]}`，op 为
`{"op":"submit","entryId","payer","payee","amount"}`、`{"op":"cancel","entryId"}`、
`{"op":"settle"}`。状态写入 `<ledger.json>.state/` 目录：

- `ledger.log` — 追加式变更日志（JSONL），每条记录写后 fsync。
- `ledger.snap` — 快照；先写 `ledger.snap.tmp` 并 fsync，再 rename，再 fsync 目录。
- `ledger.wm` — durableWatermark `{seq, snapHash}`，rename 之后原子写入。

`recover` 输出 `{source, recoveryHash, state}`，`recoveryHash` 是规范化状态 JSON 的
SHA-256。退出码：`0` 成功；`2` 业务错误（如 `ENTRY_NOT_PENDING`）；`75` 模拟崩溃。

## 崩溃语义

`settle` 的持久化顺序：

1. 内存中计算净额并把全部 pending 条目置 `settled`；
2. 写 `ledger.snap.tmp` + fsync；
3. **崩溃点 `settle:beforeRename`** — 此时崩溃，磁盘上无任何 settle 痕迹，
   恢复后无条目变为 settled；
4. rename tmp → `ledger.snap` + 目录 fsync；
5. 向日志追加 `settle` 记录 + fsync（保证 watermark 损坏时完整重放日志也能
   重现 settle）；
6. **崩溃点 `settle:afterRename`** — 此时崩溃，快照已 rename、日志已含 settle
   记录，重启恢复后必须呈现全部 settled；
7. 写 durableWatermark（tmp + fsync + rename + 目录 fsync）。

恢复规则：

- watermark 缺失或损坏 → 忽略快照，从seq 0 重放完整变更日志；
- watermark 有效但快照缺失或哈希不符 → 回退到完整日志重放；
- 两者皆有效 → 加载快照并重放 `seq > watermark.seq` 的日志记录；
- 日志尾部撕裂（半行 JSON）→ 截断忽略。

## 业务规则

- 重复 `entryId` 的 submit 幂等：不重复入账、不追加日志；
- cancel 只处理 `pending` 条目；取消已轧账/已取消条目以 `ENTRY_NOT_PENDING`
  拒绝且不改变任何状态，取消不存在条目以 `ENTRY_NOT_FOUND` 拒绝；
- settle 原子地把全部参与条目置 `settled`，并按参与者计算净额
  （收入 − 支出，净额总和为 0）；无 pending 条目时为 no-op。

## 测试

```sh
node --test 2>&1 | tee test-result.txt
```

- `test/ledger.test.js` — 领域逻辑单元测试；
- `test/cli.test.js` — 真实子进程在每个崩溃点崩溃后重启恢复、watermark/快照
  损坏恢复、幂等与 `ENTRY_NOT_PENDING` 验收；
- `test/enumeration.test.js` — 对 n=1..6 条目共 7113 个场景（全部取消顺序 ×
  全部崩溃点）逐一与内存参考模型对照恢复哈希。

恢复哈希以 `# RECOVERY_HASH ...` TAP 注释真实记录在 `test-result.txt` 中。
