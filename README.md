# food-lot-traceability

食品厂批次追溯：从成品反查原料批、设备清洗与检验记录。纯 Node.js 22 标准库实现，无第三方依赖，单机离线运行。

## 用法

```sh
node cli.js trace --in <输入目录> --out <输出目录>
node --test   # 运行测试
```

## 输入

输入目录中的四个文件（`lots.json` 必需，其余可缺省视为空）：

- `lots.json` — 批次数组：`{"id", "type", "production_start"?, "production_end"?}`，`type` 为 `raw_material` / `intermediate` / `finished_good`，时间为 ISO 8601。
- `edges.jsonl` — 谱系边（合流/分流）：`{"from", "to", "valid_from"?, "valid_to"?}`，表示原料/中间批投入目标批次；`valid_*` 为边的有效时间窗。
- `tests.jsonl` — 检验/清洗记录：`{"id", "lot", "result": "pass"|"fail"}`。
- `corrections.jsonl` — 更正，按序应用：
  - `{"type": "revoke_test", "test_id"}` 撤销一次测试（不可重复撤销）；
  - `{"type": "update_edge", "from", "to", "valid_from"?, "valid_to"?}` 修改边的有效时间窗。

## 语义

- 谱系为 DAG，支持合流（多原料汇成一个成品）与分流（一个原料进多个批次）。
- **FAIL**：批次自身有未撤销的不合格测试，或不合格沿边从上游传播而来——仅当边的有效时间窗完整覆盖目标批次的生产窗口时才传播。
- **PASS**：无不合格证据，且自身有合格测试，或全部直接上游均为 PASS（结构传播，不受时间窗限制）。
- **UNKNOWN**：证据缺失。UNKNOWN 绝不视为 FAIL。
- 批次无生产窗口时视为总是被边覆盖；单边缺失按 ±∞ 处理。

## 增量重算与证书

更正到达后不做全量重算：引擎只重算受影响批次的下游闭包（`stats.lotsRecomputed` 可观察），并只为证书内容发生变化的成品换发证书。证书内容（lot、status、不合格来源测试、直接上游状态）经规范化 JSON 序列化后取 SHA-256 作为 `certificate_hash`。旧证书标记 `revoked` 并以 `superseded_by` 指向新证书，形成作废链，完整历史写入 `certificates.jsonl`。

## 输出

- `trace.json` — 每个成品的 `status` 与 `certificate_hash`，全部批次状态，更正应用/拒绝计数。
- `certificates.jsonl` — 全部证书记录（含已作废），含 `seq`、`state`、`superseded_by`、`basis`。
- `errors.jsonl` — 仅在出错时写出。

## 错误与退出码

- 环、引用不存在的批次（边/测试）、重复 id、非法时间窗等结构性错误：写入 `errors.jsonl`，退出码 2，**不产生任何证书或 trace 输出**。
- 更正目标不存在（测试/边）、重复撤销、未知更正类型：该更正被跳过并记入 `errors.jsonl`，其余处理继续，退出码 2。
- 参数错误退出码 1，成功为 0。

## 验收对照

- `test/incremental.test.js`：60 组 n≤10 随机 DAG + 随机更正，增量引擎与独立递归全量算法（`src/full.js`）逐批次对照状态、污染来源与证书 basis；并验证增量重算只触及下游闭包。
- `test/corrections.test.js`：撤销不合格测试后仅下游受影响成品从 FAIL 变为 PASS/UNKNOWN，无关分支证书 hash 不变；修改边时间断开传播窗口后证书 hash 变化且旧证书记为 revoked。
- `test/cli.test.js`：环被拒绝（exit 2，无部分证书）、悬空引用、缺失更正目标、端到端作废链。
- `test/propagation.test.js`：合流/分流、时间窗门控、UNKNOWN≠FAIL。

## 测试结果（真实运行）

```
$ node --test
ok 1 - test/cli.test.js
ok 2 - test/corrections.test.js
ok 3 - test/helpers.js
ok 4 - test/incremental.test.js
ok 5 - test/propagation.test.js
# tests 5
# pass 5
# fail 0
```

`examples/` 目录含一组示例输入及实际输出（两个成品先 FAIL，撤销不合格测试后换发 PASS 证书，旧证书进入作废链）。
