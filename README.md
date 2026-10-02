# daybook — 结算日终未发布历史重写（崩溃可恢复）

Node.js 22，仅标准库，单机离线。库在 `src/`，CLI 为 `cli.js`，测试用 `node:test`。

## 命令

```
node cli.js [--dir DIR] begin <date>        # 开启结算日（YYYY-MM-DD）
node cli.js [--dir DIR] add '<entry-json>'  # 追加分录 {"id","account","amount","type"?,"reversalOf"?}
node cli.js [--dir DIR] rewrite <plan.json> # 重写当前 open 日
node cli.js [--dir DIR] commit              # 提交当日
node cli.js [--dir DIR] recover             # 崩溃后恢复并修复
node cli.js [--dir DIR] status              # 输出状态 + 依据文件
```

数据目录默认 `./.daybook`，可用 `--dir` 或 `DAYBOOK_DIR` 覆盖。

## 存储与崩溃恢复

三个文件：`snapshot.json`（已检查点状态）、`wal.jsonl`（在途变更：header 行 + 全量状态行）、`HEAD`（指针，值为 `snapshot` 或 `wal`）。

每次变更（begin/add/rewrite/commit）走同一条持久化流水线：

1. 写 `wal.jsonl.tmp`
2. **故障点 `before-fsync`** —— fsync 之前崩溃
3. fsync tmp
4. **故障点 `before-rename`** —— rename 之前崩溃
5. rename `wal.jsonl.tmp` → `wal.jsonl`（原子）
6. 更新 `HEAD=wal`（tmp+fsync+rename）
7. **故障点 `after-head`** —— HEAD 更新后、checkpoint 前崩溃
8. checkpoint：写 `snapshot.json`，`HEAD=snapshot`，删除 wal

恢复规则（`recover`，幂等）：

- `HEAD=snapshot` → snapshot 权威；丢弃 `wal.jsonl.tmp` 与陈旧 `wal.jsonl` → 旧版本
- `HEAD=wal` → `wal.jsonl` 权威（rename 先于 HEAD 更新，故 wal 必然完整）；重放为 snapshot → 新版本
- 指针与文件不一致（HEAD 缺失/非法、HEAD=wal 但 wal 缺失或损坏、snapshot 损坏）→ **恢复歧义，exit 23**

## recover 后的 status

| 状态 | 含义 | 依据文件 |
|---|---|---|
| `OLD_COMMITTED` | 无 open 日，最近一日已提交（旧版本） | `HEAD`, `snapshot.json` |
| `OPEN_OLD` | 当日仍 open，在途变更未生效 | `HEAD`, `snapshot.json` |
| `OPEN_NEW` | 当日 open，在途 rewrite 已生效 | `HEAD`, `wal.jsonl` |
| `COMMITTED_NEW` | 在途 commit 已生效 | `HEAD`, `wal.jsonl` |

`status` 输出 JSON：`{"status","date","entries","basis":[...]}`，`basis` 即判定依据文件。

## rewrite 计划

```json
{
  "date": "2026-10-03",            // 可选；与当前 open 日不符 → exit 21
  "dropIds": ["e3"],               // 删除分录
  "moveBefore": [["e2", "e1"]],    // 把 e2 移到 e1 之前（也接受 {"id","before"}）
  "fixAmounts": {"e2": -100}       // 修正金额
}
```

约束（应用顺序：fixAmounts → drop → move → 校验）：

- 仅允许当前 open 且未 commit 的日；引用已 commit 日的分录 → `REWRITE_CROSS_DAY` exit 21
- `REVERSAL` 不得先于其原交易（原交易被删或排序后反超）→ `PLAN_INVALID` / `REVERSAL_CAUSALITY` exit 22
- 每账户日净额不变 → 否则 `PLAN_INVALID` / `NET_CHANGED` exit 22

## 退出码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 状态/用法错误（如无 open 日） |
| 21 | 跨日重写 `REWRITE_CROSS_DAY` |
| 22 | 计划非法 `PLAN_INVALID`（`reason`: `NET_CHANGED` / `REVERSAL_CAUSALITY` / …） |
| 23 | 恢复歧义 `RECOVERY_AMBIGUOUS` |
| 70 | 故障注入触发（`FAULT_INJECTED <point>`） |

故障注入：库函数接受 `{faultAt}`；CLI 用环境变量 `DAYBOOK_FAULT_AT=before-fsync|before-rename|after-head`。

## 测试（真实结果）

`node --test`（Node v22.22.1，本仓库实际运行）：

```
# tests 4        # 测试文件：enumerate / faults / flow / plan（共 23 个子测试）
# pass 4
# fail 0
```

- `test/flow.test.js` — 正常 begin/add/rewrite/commit；CLI 端到端
- `test/faults.test.js` — 三个故障点 × (commit, rewrite) 注入后 recover 结果确定（before-fsync/before-rename → OPEN_OLD，after-head → COMMITTED_NEW/OPEN_NEW），恢复幂等、可重试
- `test/plan.test.js` — REVERSAL 因果违反拒绝（exit 22）、净额保护（exit 22）、跨日重写（exit 21）、恢复歧义（exit 23）
- `test/enumerate.test.js` — n≤6 分录枚举全部 drop 子集 × 全部单点 move，共 **2934** 个计划与独立 oracle 对照（接受 96 / 拒绝 2838），验证净额不变与因果约束
