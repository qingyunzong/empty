# Biobank Freezer Allocation

Node.js 22，仅使用标准库与 `node:test`。将新到生物样本管分配到 -80℃ 冻存架，
支持温区/容量/同项目相邻硬约束、项目配额、全局公平调度、可逆抢占、层级撤销、
确定性证书哈希与崩溃恢复。

## 运行

```sh
node cli.js --config config.json [--events events.jsonl] [--log bank.log]
# 事件缺省从 stdin 读取；每步结果以 JSONL 写到 stdout
```

测试：

```sh
node --test test/*.test.js
```

## 配置

```json
{
  "racks": [{ "id": "r1", "zone": "-80", "capacity": 4 }],
  "quotas": { "alpha": 4 },
  "defaultQuota": 5,
  "agingWeight": 10,
  "freezeDelay": 3,
  "maxActiveSamples": 1000
}
```

- `racks`：冻存架，`zone` 为温区，`capacity` 为槽位数（槽位编号 0..capacity-1）。
- `quotas` / `defaultQuota`：每个项目最多同时在架样本数。
- `agingWeight`：公平调度中 1 级优先级折合的等待时间单位。
- `freezeDelay`：样本放入后经过多少时间点视为已冻结（冻结后不可抢占、不可取消）。
- `maxActiveSamples`：活跃样本（等待+在架）上限，超出报 `CAPACITY_OVERFLOW`。

## 事件（JSONL，每行一个）

```json
{"type":"arrive","time":0,"sample":{"id":"s1","project":"alpha","priority":5,"deadline":50,"zone":"-80"}}
{"type":"correct","time":1,"sampleId":"s1","priority":9,"deadline":60}
{"type":"cancel","time":2,"sampleId":"s1"}
{"type":"undo","time":3,"to":2}
```

- 同一 `time` 的连续事件合并为一个调度步（step），步末统一调度；`undo` 独占一步。
- `correct` 可改 `priority` / `deadline`（样本须处于等待或在架状态）。
- `cancel` 可撤销等待中或未冻结的在架样本；冻结样本不可取消（`INVALID_EVENT`）。
- `undo.to` 回滚到事件点 K（保留前 K 个非 undo 事件），可层级回滚到任意事件点；
  状态由前缀事件确定性重放，重放哈希与首次运行一致。

## 调度策略

- **硬约束装箱**：温区匹配、容量、项目配额、同项目相邻（同一项目在同一架内
  必须构成连续槽位块）。等待数 ≤ 12 时精确搜索最大可放置数（并列时偏好
  高排名样本与低位槽位），否则按排名贪心。
- **公平排名**：`score = priority * agingWeight + (now - arriveTime)`，
  分数降序，同分按样本 ID 升序。等待自动老化，因此高优不会饿死、
  低优也不会被高优新到样本无限插队。
- **抢占**：仅允许撤回**未冻结**样本，且抢占者的有效分数须高于被撤者；
  被撤样本回到等待队列（保留原到达时间），并写入可逆日志（`preempted` 记录），
  `undo` 可恢复。
- **截止时间**：调度时 `deadline < now` 的等待样本过期移出并记录原因。

## 输出与证书

每步 stdout 一行 JSON：

```json
{"step":1,"time":0,"events":[...],"placed":[{"sample":"s1","rack":"r1","slot":0}],
 "preempted":[],"expired":[],"rejected":[],"cancelled":[],"waiting":["s2"],
 "eventPoint":1,"hash":"<sha256>"}
```

`hash` 为规范化状态（当前时间、事件点、在架/等待/冻结集合）的 SHA-256，
完全确定：相同事件序列在任何机器上重放得到相同哈希序列。

## 持久化与崩溃恢复

`--log bank.log` 开启追加式日志，每条记录 `{step, events, hash, checksum}`
（`checksum` 为前三者的 SHA-256），写入后 `fsync`。重启时逐条校验；
第一条无法解析或校验和不匹配的记录（如崩溃造成的半截写入）被拒绝：
日志截断到最后一条有效记录，stderr 输出 `LOG_CORRUPTED` 警告，从有效前缀恢复。

## 错误

非法事件（`INVALID_EVENT`）、容量溢出（`CAPACITY_OVERFLOW`）、时间倒退
（`TIME_REGRESSION`）、非法撤销点（`INVALID_UNDO`）、非法配置
（`INVALID_CONFIG`）均输出 JSON 到 stderr 并以 exit 2 退出，且不改变任何状态
（不追加日志、内存状态回滚）。

```json
{"error":{"code":"TIME_REGRESSION","message":"event time 3 is before current time 5"}}
```

## 测试

- `test/schedule.test.js`：20 样本混合到达场景（确定性、不变量、CLI 与库哈希一致）
  及 n≤12 随机实例对照暴力枚举的最优可放置数。
- `test/fairness.test.js`：配额耗尽后低优等待、高优不得无限插队（老化生效）、同分按 ID 升序。
- `test/preempt_undo.test.js`：抢占仅撤回未冻结样本、undo 恢复被撤样本、重放一致性。
- `test/errors_crash.test.js`：错误分类（exit 2 + stderr JSON + 状态不变）、
  崩溃半截日志记录拒绝、校验和损坏拒绝。

### 真实测试输出

```
$ node --test test/*.test.js
# Subtest: test/errors_crash.test.js
ok 1 - test/errors_crash.test.js
# Subtest: test/fairness.test.js
ok 2 - test/fairness.test.js
# Subtest: test/preempt_undo.test.js
ok 3 - test/preempt_undo.test.js
# Subtest: test/schedule.test.js
ok 4 - test/schedule.test.js
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4370.124152
```
