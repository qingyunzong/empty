# trace-view

质量追溯系统：把批次加工链抽象成状态机（DFA），在离线单机上完成追溯视图的
最小化合并、新旧规则等价性判定（含最短反例证书）、以及按批次层级
（savepoint layer）回滚错误导入。仅使用 Node.js 22 标准库，测试基于
`node:test`。

## 模型

- **状态** = 当前可追溯视图。每个批次一个视图状态，标签为
  `(pending, 可达缺陷集合)`；可达缺陷集合 = 本批缺陷 ∪ 全部祖先批缺陷
  （沿 `parents` 谱系闭包）。
- **符号** = `merge` / `split` / `test` / `ship`（批次记录里的 `on` 转移）。
- **最小化** = 对可达部分做划分精化（bisimulation）。初始划分按键
  `(pending, 缺陷集合)`，因此**谱系合并保持可达缺陷集合不变**；
  `pending: true` 的未决状态是真实状态，**不会被当作不可满足而剪枝**。
- **等价证书** = 在两个最小化视图的积图上 BFS，返回使两侧缺陷集合不同的
  **最短符号串**作为 witness；返回 `null` 即两版规则等价。
- **缺失转移** 规范化为隐式 sink（空缺陷集、非 pending、自环），参与
  最小化与等价判定。

## 文件格式

批次文件（JSONL，每行一条）：

```json
{"meta":"start","start":"raw-milk"}
{"batch":"blend-vat","parents":["raw-milk","culture-a"],"defects":[],"pending":false,"on":{"test":"qc-hold"}}
```

- `parents`：谱系边，必须引用已知批次且成 DAG（允许引用更早层导入的批次）。
- `defects`：本批观察到的缺陷 id。
- `pending`：检验结果未决。
- `on`：加工算子转移，键必须是 `merge/split/test/ship`。

命令文件（JSONL）：`import` / `equiv` / `rollback` 见下。

## 运行

```bash
node --test                          # 全部测试
node cli.js <cmd.jsonl> [journal]    # 执行命令文件；journal 默认 <cmd.jsonl>.journal
```

命令：

```json
{"cmd":"import","file":"batches-l1.jsonl","layer":1}
{"cmd":"equiv","a":"rules-v1.jsonl","b":"rules-v2.jsonl"}
{"cmd":"rollback","layer":2}
```

- `import`：`layer` 可省略（自动取下一层）；显式给出时必须等于
  `recoveredTo + 1`，否则报层号空洞。
- `rollback layer N`：截断日志到第 N 层之前的 savepoint（即删除第 N 层及
  以上），`recoveredTo` 变为 `N-1`。

每条命令在 stdout 输出一行 JSON，字段含 `minStates` / `equal` / `witness` /
`recoveredTo`。

## 崩溃恢复

导入按 savepoint 层写入写前日志：`begin -> batch*/meta* -> commit`。
**每条 JSONL 记录写入后立即 fsync**，因此崩溃恢复点恰好是最后一条完整
fsync 的记录。重启恢复时：

- 只重放**完整层**（有 `commit` 的层）；未提交的层记录被丢弃；
- 撕裂的尾部行（无换行结尾）被截断并 fsync，后续追加从最后一条完整
  记录之后继续；
- `recoveredTo` = 最后一个完整层的层号。

## 错误与退出码

以下领域错误在 stderr 输出 JSON 并以**退出码 4** 结束：

| 错误 | code |
| --- | --- |
| 环状谱系 | `CYCLIC_LINEAGE` |
| 未知父批（含未知转移目标） | `UNKNOWN_PARENT` |
| 层号空洞（导入跳层 / 日志层不连续 / 非法回滚） | `LAYER_HOLE` |
| 记录格式非法 | `VALIDATION` |

其他未预期错误退出码为 1。

## 真实输出

`node cli.js examples/cmd.jsonl /tmp/journal.jsonl`（exit 0）：

```json
{"cmd":"import","layer":1,"batches":4,"minStates":4,"recoveredTo":1}
{"cmd":"import","layer":2,"batches":1,"minStates":4,"recoveredTo":2}
{"cmd":"equiv","equal":false,"witness":["merge","test"],"minStates":[4,1]}
{"cmd":"rollback","recoveredTo":1,"minStates":4}
```

`node cli.js examples/cmd-bad-layer.jsonl /tmp/journal2.jsonl`（exit 4，
第二层命令跳层 1 -> 3）：

```json
{"cmd":"import","layer":1,"batches":4,"minStates":4,"recoveredTo":1}
```

stderr：

```json
{"error":{"code":"LAYER_HOLE","message":"layer hole: expected layer 2, got layer 3"}}
```

`node --test`：

```text
ok 1 - test/cli.test.js
ok 2 - test/dfa.test.js
ok 3 - test/exhaustive.test.js
ok 4 - test/journal.test.js
ok 5 - test/lineage.test.js
# pass 5
# fail 0
```

## 验收标准对照

1. **同构但命名不同的谱系最小化后同数** — `test/dfa.test.js`
   "isomorphic lineages..."：重命名前后 `minStates` 均为 4，且
   `equiv` 判定 `equal: true`。
2. **不等价给最短符号串** — `test/dfa.test.js` "non-equivalent views..."：
   witness 恰为 `["merge","test"]`，并验证所有更短串不区分两视图。
3. **层中 kill 后重启等于最后完整层** — `test/journal.test.js`
   "crash mid-layer..."：第 3 层写入一半（含撕裂尾行）后重启，
   `recoveredTo === 2`，批次集合与最小化结果与第 2 层末完全一致。
4. **≤6 批全枚举对照可达缺陷闭包** — `test/exhaustive.test.js`：
   枚举 n=1..6 的全部 33867 个谱系 DAG（n=6 时 32768 个），库计算的
   缺陷闭包与独立朴素实现逐一相等；并对 n≤5 全枚举验证最小化后每个
   状态的可达缺陷集合不变。

## 结构

- `src/dfa.js` — 视图 DFA：可达性、划分精化最小化、最短 witness 等价判定。
- `src/lineage.js` — 批次记录校验、谱系环检测、可达缺陷闭包、视图构建。
- `src/journal.js` — savepoint 层日志：逐条 fsync、恢复、截断。
- `src/system.js` — 事件溯源系统：import / rollback / recover / equiv。
- `cli.js` — 命令行入口。
- `examples/` — 示例批次、规则与命令文件。
