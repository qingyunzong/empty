# tiered-fee-engine

资管日终计费库与 CLI。Node.js 22，仅标准库，离线单机。

## 模型

- 成交额按**阶梯费率**累计（边际档位：每个档位区间成交额 × 档位费率）。
- 每账户每日费用 = `max(阶梯费用, 最低收费) − 返佣`，金额保留 4 位小数。
- 账户可适用多个**费率包**（按规则版本分组）；取净费用最低者。
  **并列最优全部列出**于 `tied`，并按规则 ID 字典序决胜（`package` 为胜者）。
- 费率规则按版本组织（`v1` / `v2`），`rules` 事件动态切换，全部费用节点重链重算。

## 依赖图与失效传播

节点：`trade:<id>` → `turnover:<账户>` → `tiers:<账户>` → `fee:<账户>` → `invoice:<账户>`，
另有 `rules:<版本>` → 全部 `fee:*`（动态拓扑，版本切换即重连）。

- 各档成交额**差分维护**：成交变动只更新被跨越的档位区间（`tierDelta`）。
- **失效传播只触碰跨档账户**：未跨档的变动在档位节点内闭式吸收
  （`invalidated` 仅含 `turnover/tiers`）；跨档才下传 `fee`/`invoice` 节点。
- 改单 = 撤销旧成交 + 新增成交（两步差分，**不双计**）。
- **负成交仅允许作为冲正**，必须经 `of` 引用同账户原单，且不超过原单剩余额。
- 日终输出**确定性费用证书**：规范 JSON 的 SHA-256，按账户链式（含前序证书哈希），
  同一事件流重放必得同一证书。

## 持久化与故障恢复

`--journal <path>` 开启发票行持久化（JSONL 追加 + fsync）。
故障点为写发票行中途：恢复时截断未完整写入的尾部行，已提交行按 `day:account`
键去重——**重启不会重复开票**（重跑输出 `billed:false`）。

## 事件格式（JSONL）

```json
{"type":"account","account":"A","packages":["P-STD"]}
{"type":"trade","id":"t1","account":"A","amount":1000000}
{"type":"trade","id":"r1","account":"A","amount":-200000,"of":"t1"}
{"type":"amend","id":"t1","newId":"t1b","amount":700000}
{"type":"cancel","id":"t1b"}
{"type":"rules","version":"v2"}
{"type":"eod"}
```

## 运行

```sh
node --test                                          # 全部测试
node src/cli.js examples/events.jsonl --day 2026-10-03
cat events.jsonl | node src/cli.js --day 2026-10-03 --journal invoices.jsonl
```

- stdout：每事件 `fee-diff`（差额、命中档位、失效节点、差额原因）、
  `rules` 重定价汇总、日终 `eod`（命中档位明细、并列费率包、证书、发票行）。
- 任何输入/校验错误：stderr 输出 `error: ...`，**退出码 6**。

## 测试

- `test/engine.test.js` — 改单不双计、跨档失效传播、并列最优与规则 ID 决胜、
  撤单后低于最低收费、冲正校验、证书确定性重放、版本切换重连、返佣。
- `test/brute.test.js` — 4 个随机种子 × 300 事件与小规模暴力枚举（朴素重算）对照。
- `test/journal.test.js` — 写发票行中途崩溃的恢复与不重复开票。
- `test/cli.test.js` — CLI 输出、退出码 6、日志幂等、文件入参。
