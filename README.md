# day-ledger

结算日终批处理账本：支持重写当日未发布历史，崩溃后可恢复到明确版本。
Node.js 22，仅标准库，测试使用 `node:test`。

## CLI

```
day [--dir PATH] [--crash-at POINT] <command>
  begin <date>          开启新日 (YYYY-MM-DD)
  add <json-entry>      追加分录 {id,account,amount[,type,refId]}
  rewrite <plan.json>   重写当前 open 日 {date,dropIds,moveBefore,fixAmounts}
  commit                持久化提交当前 open 日
  recover               崩溃后分类并修复
  status                只读分类（不修复）
```

存储目录由 `--dir` 或环境变量 `DAY_DIR` 指定（默认 `.day`）。故障注入用
`--crash-at` 或环境变量 `DAY_CRASH_AT`。

## 存储文件

- `HEAD` — 当前日指针 `{date, state: open|committed, gen}`，唯一事实来源
- `snapshot.json` — 最近已提交快照（JSON payload + sha256 尾行校验）
- `snapshot.json.tmp` — commit 期间暂存的新快照，校验和有效才可信
- `wal.jsonl` — 当前 open 日的分录日志
- `wal.jsonl.archived` — commit 过程中被改名的 wal（提交意图标记）

## commit 协议与故障点

1. 写 `snapshot.json.tmp` → **故障点 `before-fsync`**（模拟 OS 丢弃未 fsync 的尾部，文件变 torn）
2. fsync tmp + 目录 → **故障点 `before-wal-rename`**
3. `wal.jsonl` → `wal.jsonl.archived`；tmp → `snapshot.json`
4. 更新 `HEAD` 为 committed → **故障点 `after-head-update`**
5. 清理 archived wal

## recover 分类（输出 `STATUS=<s> evidence=<files>`）

| 状态 | 条件 | 依据文件 |
|---|---|---|
| `OLD_COMMITTED` | 无 HEAD 且无在途产物，快照有效（或空库） | `snapshot.json` |
| `OPEN_OLD` | HEAD open，wal 在，无有效暂存快照 | `wal.jsonl` |
| `OPEN_NEW` | HEAD open，暂存快照校验和有效（已持久） | `snapshot.json.tmp` |
| `COMMITTED_NEW` | HEAD committed 且 snapshot.json 有效 | `HEAD`, `snapshot.json` |

恢复动作：`OPEN_OLD` 丢弃暂存残片；`OPEN_NEW` 把已持久暂存快照采纳为 open
日的 wal（回到明确的最新版本，日仍 open）；`COMMITTED_NEW` 清理 archived wal。

歧义（exit 23）：HEAD 损坏、HEAD committed 但快照缺失/无效、wal 已归档但无
暂存快照且 HEAD 仍 open、wal 与 archived 同时存在等。

## rewrite 约束

- 仅允许当前 open 日且未 commit；`plan.date` 必须等于 open 日日期 → 否则 exit 21
- `dropIds` / `moveBefore` / `fixAmounts` 引用的 id 必须存在且未被 drop
- 每个账户的日净额在重写前后必须相等 → 否则 `PLAN_INVALID` exit 22
- `REVERSAL` 不得先于其 `refId` 原交易（原交易被 drop 而保留冲正同样拒绝）→ exit 22

## 退出码

- `0` 成功；`2` 用法/状态错误；`21` 跨日或已提交重写；`22` 计划非法（净额/因果）；
  `23` 恢复歧义；`75` 模拟崩溃

## 测试

```
node --test
```
