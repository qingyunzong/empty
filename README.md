# 临床样本审计系统：复核员时段分配

运行时为 Node.js 22，仅使用标准库与 `node:test`，无任何第三方依赖。

系统为临床审计案件分配复核员时段：案件带有风险分、法定截止、所属科室；
复核员带有技能集合与不可用时段。更正可升降风险，申诉可撤销结论。
每次分配产出可审计证书（SHA-256 哈希链），事件日志支持快照崩溃恢复。

## 布局

- `src/schedule.js` — 调度器：技能×时段约束、风险×截止排序、科室配额、抢占补偿
- `src/engine.js` — 事件溯源引擎：open/correct/appeal/close/assign 事件与证书哈希链
- `src/store.js` — JSONL 事件日志、快照、崩溃恢复、并发事件排序
- `bin/cli.js` — CLI（`open/assign/correct/appeal/close/snapshot/verify`）
- `test/*.test.js` — 单元、CLI 与验收测试

## 核心规则

- **技能×时段约束**：案件只能分给持有对应技能、且在 `[start, end)` 内无不可用段、
  无其他任务冲突的复核员；`end` 不得超过法定截止（只排按时时段）。
- **排序**：优先级分 = `risk*1000 + credit*100 + 等待年龄`，降序；并列时按
  （法定截止升序， 案件ID)。风险与法定截止共同排序，等待案件随时间老化升权。
- **科室公平**：当等待案件来自 ≥2 个科室时，单科室每轮分配数上限为
  `max(1, floor(deptShare * 复核员数))`（默认 `deptShare=0.5`），超限案件以
  `QUOTA_DEFERRED` 拒绝码 defer；单科室 workload 不受限。
- **调度方法**：合格案件 ≤9 时用精确枚举（候选开始时刻取「now/不可用段结束 +
  工期子集和」，左移论证保证完备），最大化（按时高险覆盖， 按时总覆盖）；
  >9 时用同规则的贪心。
- **抢占**：高险案件（`risk >= highRisk`，默认 8）可抢占低险且尚未开始的任务；
  被抢占案件获得补偿信用（`compensationCredit`，默认 5）并记入证书
  `preemptions` / `compensations`。
- **申诉**：`appeal` 打开申诉时原结论置为 `frozen`（冻结而非删除）；
  `close appeal` 按层级判定——申诉层级 ≥ 结论层级则 `revoked`（案件重回队列），
  否则 `confirmed`。已签字结论不可被 `correct` 修改。
- **并发判定**：事件按（逻辑时， 来源， 案件ID）排序判定；无案件 ID 的系统事件
  （ASSIGN）排在同一逻辑时的案件事件之后，再以追加序号兜底。
- **证书**：每个事件按 `sha256(prevHash | canonical(event))` 链入状态哈希；
  分配证书含分配、拒绝码、抢占、补偿与 `prevHash`，可独立重算校验。

## 错误码与退出码

- `SKILL_MISMATCH`（技能不符）、`DEADLINE_PAST`（截止过去）、`DUPLICATE_APPEAL`
  （重复申诉）→ **exit 8**
- 其他领域错误（`CASE_CLOSED`、`NO_CONCLUSION`、`NOT_ASSIGNED` 等）→ exit 1
- 用法错误 → exit 2

## 使用

状态目录包含 `reviewers.json`（必需）、`config.json`（可选），以及系统维护的
`events.jsonl` 与 `snapshot.json`：

```json
{ "reviewers": [
  { "id": "R1", "skills": ["echo", "ct"], "unavailable": [{ "start": 2, "end": 4 }] },
  { "id": "R2", "skills": ["ct"], "unavailable": [] } ] }
```
```json
{ "deptShare": 0.5, "highRisk": 8, "compensationCredit": 5 }
```

```sh
node bin/cli.js --state /tmp/audit-demo open   --case C1 --dept cardio --risk 9 \
  --deadline 20 --skill echo --duration 2 --time 0 --source lab-1
node bin/cli.js --state /tmp/audit-demo assign --time 0
node bin/cli.js --state /tmp/audit-demo correct --case C2 --risk 8 --time 1 --source qc
node bin/cli.js --state /tmp/audit-demo close case --case C1 --result approved --level 1 --time 3
node bin/cli.js --state /tmp/audit-demo appeal --case C1 --level 2 --time 4 --source ombudsman
node bin/cli.js --state /tmp/audit-demo close appeal --case C1 --time 5
node bin/cli.js --state /tmp/audit-demo snapshot --time 6
node bin/cli.js --state /tmp/audit-demo verify
```

## 真实输出记录

以下输出为上述命令在本仓库真实运行的结果（状态目录含上文两个 JSON 文件，
C2 以 risk 3 / ct / 截止 20 开立）。

`assign --time 0`（R1 在 [2,4) 不可用，C2 被排到 [4,6)）：

```json
{
  "kind": "assignment-certificate",
  "time": 0,
  "source": "cli",
  "method": "exact",
  "assignments": [
    { "caseId": "C1", "reviewerId": "R1", "start": 0, "end": 2 },
    { "caseId": "C2", "reviewerId": "R1", "start": 4, "end": 6 }
  ],
  "rejections": [],
  "preemptions": [],
  "compensations": [],
  "prevHash": "59709ba7c0e0283446fded8160e57cf89c7abaa9e9dc785f5f756b3808653dff",
  "hash": "bfa8e56582cb294e25221707bbfc5f16a56c0d88131fd6cfc53c7480395e720a"
}
```

`correct --case C2 --risk 8 --time 1` 后 `assign --time 1`：C1 已开始（[0,2)）
保持固定，只有未开始的 C2 参与重排：

```json
{
  "kind": "assignment-certificate",
  "time": 1,
  "source": "cli",
  "method": "exact",
  "assignments": [
    { "caseId": "C2", "reviewerId": "R1", "start": 4, "end": 6 }
  ],
  "rejections": [],
  "preemptions": [],
  "compensations": [],
  "prevHash": "1fb425f7b323e98a5b4fb6d30ed3ebb7cac0fea34fd4d41dc7fb88c4a9ce7a4d",
  "hash": "23da42eb75500d33a1d5a99684a16255cda1c005e6c7d1bd3f463909e54834d3"
}
```

`close appeal --case C1 --time 5`（申诉层级 2 ≥ 结论层级 1 → 回滚）：

```json
{ "ok": true, "event": { "type": "APPEAL_CLOSE", "time": 5, "source": "cli",
  "caseId": "C1", "decision": "revoked" } }
```

`snapshot --time 6` 与 `verify`（崩溃恢复后证书可重算，两哈希一致）：

```json
{ "ok": true, "snapshot": "/tmp/audit-demo4/snapshot.json", "eventCount": 8,
  "certHash": "5a8a91dc98da755f1e97aa05e2adfea21673cc9ec8de42599c049f771928cb2a" }
```
```json
{ "ok": true,
  "recoveredHash": "5a8a91dc98da755f1e97aa05e2adfea21673cc9ec8de42599c049f771928cb2a",
  "recomputedHash": "5a8a91dc98da755f1e97aa05e2adfea21673cc9ec8de42599c049f771928cb2a",
  "match": true, "eventCount": 8 }
```

抢占示例（R1 在 [0,3) 不可用；LOW risk 3 / 截止 10 先占 [3,7)，
HIGH risk 9 / 截止 8 在 t=1 开立）`assign --time 1`：

```json
{
  "kind": "assignment-certificate",
  "time": 1,
  "source": "cli",
  "method": "exact",
  "assignments": [
    { "caseId": "HIGH", "reviewerId": "R1", "start": 3, "end": 7 }
  ],
  "rejections": [
    { "caseId": "LOW", "code": "PREEMPTED" }
  ],
  "preemptions": [
    { "preempted": "LOW", "by": "HIGH", "reason": "replan" }
  ],
  "compensations": [
    { "caseId": "LOW", "credit": 5 }
  ],
  "prevHash": "d5eeef058040ac14046bab2a8e6109689911ad1d4e57ed143a0424509c3a4f07",
  "hash": "a0ebc64879d8bfb2662e1dab1bdd606fb8e840821880d3d84fd94a6d647d8e5b"
}
```

exit 8 错误（真实退出码）：

```console
$ node bin/cli.js --state D appeal --case C1 --level 2 --time 11   # 重复申诉
{"ok":false,"code":"DUPLICATE_APPEAL","message":"case C1 already has an open appeal"}
exit=8
$ node bin/cli.js --state D open --case C9 ... --skill mri ...   # 技能不符
{"ok":false,"code":"SKILL_MISMATCH","message":"no reviewer holds required skill: mri"}
exit=8
$ node bin/cli.js --state D open --case C9 ... --deadline 3 --time 11  # 截止过去
{"ok":false,"code":"DEADLINE_PAST","message":"statutory deadline 3 is not after logical time 11"}
exit=8
```

## 测试

```sh
node --test test/*.test.js
```

真实运行结果：

```
# tests 4
# pass 4
# fail 0
```

验收覆盖（`test/acceptance.test.js`）：

1. **n≤9 枚举对照**：调度器（exact）与测试内独立暴力枚举在 30 个随机实例上
   按时高险覆盖完全一致；9 高险案件单复核员实例覆盖数 = 6。
2. **科室垄断受限 + 老化**：12 案件（10 alpha / 2 beta）2 复核员，每轮单科室
   上限 1，alpha 垄断被 `QUOTA_DEFERRED` 限制；下一轮最老的等待案件优先进入。
3. **更正重排**：风险更正后未开始任务重排，已签字结论不可修改且内容不变。
4. **快照恢复**：快照后继续写事件并模拟撕裂的日志尾行，恢复态哈希与
   从头重算哈希一致，`verify` 通过。
