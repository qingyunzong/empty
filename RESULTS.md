# RESULTS

环境：Node.js v22.22.1（`node --version`），仅标准库，测试框架 `node:test`。以下均为真实运行输出。

## `node --test`（2026-10-08 运行）

```
ok 1 - test/cli.test.js
ok 2 - test/scheduler.test.js
ok 3 - test/store.test.js
# tests 3
# suites 0
# pass 3
# fail 0
# duration_ms 6251.200309
```

子测试明细（全部通过）：

```
test/scheduler.test.js
ok 1 - acceptance 1: DP plan matches independent exhaustive DFS for <=4 jobs
ok 2 - certificate carries input hash, objective and tie-break rank
ok 3 - E_INFEASIBLE reports the first unschedulable jobId
ok 4 - invalid input is rejected with E_INVALID
ok 5 - exact optimum on a hand-checked instance
ok 6 - scales to 20 jobs deterministically

test/store.test.js
ok 1 - commit makes a new plan version visible and indexed
ok 2 - acceptance 2: commit after concurrent job change fails with E_SNAPSHOT
ok 3 - acceptance 3a: crash after_stage discards the staged plan, keeps the old one
ok 4 - acceptance 3b: crash after_commit makes the new plan fully visible
ok 5 - acceptance 3c: infeasible replan does not overwrite the old plan
ok 6 - torn WAL tail is ignored during recovery

test/cli.test.js
ok 1 - CLI end-to-end: set-jobs, plan, verify, lookup
ok 2 - CLI crash injection respects the commit boundary
ok 3 - CLI reports E_INFEASIBLE as JSON and keeps the old plan
ok 4 - CLI reads jobs from stdin when --file is omitted
```

## 验收点 1：与独立 DFS 穷举一致

`test/scheduler.test.js` 用确定性 PRNG（mulberry32，种子 1..300）生成 ≤4 工单实例（随机 release/due/duration/设备子集/设备容量），逐字段比较精确 DP 与 `src/verify.js` 的独立 DFS（枚举全部排列 × 设备选择）：目标值、设备分配、每台设备工序序列、证书 `tieCount`、以及不可行时的 `E_INFEASIBLE.details.jobId`。300 个实例全部一致（其中含不可行实例，两侧错误码与 jobId 相同）。

证书示例（CLI `plan` 真实输出，4 工单）：

```json
{
  "algorithm": "exact-subset-dp",
  "inputHash": "88371369c0824533660c099e534d0b20ef9873520fd7811f3b50adeee1b5044f",
  "objective": -2,
  "tieCount": 2,
  "tieRank": 1
}
```

`node cli.js verify --db DIR` 输出 `"ok": true, "diffs": []`。

## 验收点 2：快照冲突

`test/store.test.js`「acceptance 2」：事务基于 jobsVersion 1 暂存计划后，`setJobs` 将工单集推进到 jobsVersion 2；原提交与重放提交均抛 `E_SNAPSHOT`（`details: {baseJobsVersion: 1, currentJobsVersion: 2}`），恢复后可见版本仍为 v1；基于最新工单的新事务可正常提交为 v2。

## 验收点 3：崩溃恢复边界

CLI 崩溃注入真实运行（退出码 99 为注入崩溃）：

```
### crash after_stage
exit=99
visible version: 1 jobsVersion: 1      # 暂存计划被丢弃，旧计划保留
### crash after_commit
exit=99
visible version: 2 jobsVersion: 2      # commit 标记已持久化，新计划完整可见
### infeasible (容量不足)
{"ok": false, "error": {"code": "E_INFEASIBLE", "details": {"jobId": "A"}}}
exit=2
visible version still: 2               # 错误状态不覆盖旧计划
```

## 规模与性能

20 个随机工单（含设备约束）求解实测：约 2030 ms，堆占用约 161 MB，目标值 0，平局分配数 24540；两次求解输出逐字节一致（确定性）。
