# 银行风控额度引擎（冻结/解冻/扣款）

Node.js 22，仅标准库，离线单机。库在 `bank.js`，CLI 在 `cli.js`，测试在 `test/bank.test.js`。

## 模型约定（轴模型）

- 额度轴为 `[0, totalLimit]`。扣款从左侧累计占用，`spent` 为已扣总额指针。
- **冻结**是轴上的显式区间 `[start, end]`（`scope` 写作 `"start-end"`，`amount` 必须等于区间长度），重叠或相接时自动合并。
- **解冻**只能完整切割已被冻结覆盖的区间，否则 `E_RANGE`；切割可能把一个区间分成两段。
- **扣款** `amount` 需要轴段 `[spent, spent+amount]` 通过三级检查，优先级 **显式冻结 > 分类限额 > 总限额**，首个被违反的约束即失败原因：
  1. 轴段与任一冻结区间相交 → `E_LIMIT explicit-freeze`
  2. 分类已用 + amount > 分类限额 → `E_LIMIT category-limit`（未配置的分类无限制）
  3. spent + amount > totalLimit → `E_LIMIT total-limit`
- **可用额** `available = max(0, min(首个阻挡冻结起点, totalLimit) - spent)`。
- 同一 `ts` 的请求按 `id` 字典序处理（整批先按 `(ts, id)` 排序，与输入顺序无关）。
- 重复 `id` → `E_DUP`；失败请求**无副作用**（id 仍被消费）但**写审计**。
- 审计链：每步 `sha256(prevHash + '|' + JSON(step))`，创世哈希为 64 个 `0`，报告含 `auditValid` 校验结果。

## 输入 JSONL

每行一条：`{"ts":number,"id":string,"op":"freeze|unfreeze|debit","amount":number,"scope":string}`。
- `freeze/unfreeze`：`scope` 为 `"start-end"`，`amount == end-start`。
- `debit`：`scope` 为分类名。
- 可含一行配置：`{"op":"config","totalLimit":100,"categoryLimits":{"food":50}}`。
- 配置优先级：JSONL 内 config 行 > 环境变量 `BANK_CONFIG`（JSON 文件路径）> 默认 `{totalLimit:1000}`。

## 输出 report.json

`steps[]` 每步含 `ok/code/reason/available/spent/frozen/frozenTotal/audit`；另有 `account`、`final`、`auditChain`、`auditValid`。

## 错误约定

- 业务失败（`E_RANGE`/`E_LIMIT`/`E_DUP`）：写入报告与审计，逐条打到 stderr，进程退出码 1。
- 致命错误（`E_IO`/`E_PARSE`/`E_INTERNAL`）：stderr + 退出码 1，不写报告。
- 全部成功：退出码 0。

## 运行

```sh
node --test                                  # 全部测试
node cli.js examples/ops.jsonl report.json   # CLI
```
