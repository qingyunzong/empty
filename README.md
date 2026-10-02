# xborder — 跨境结算额度 CLI

Node.js 22，仅用标准库。测试：`node --test`。

## 用法

```sh
xborder run events.jsonl --patch out.jsonl   # 或: node xborder run ...
```

- 输入：JSONL 事件流，每行一个事件。
- 输出：`--patch` 文件中每个引起 eligibleSet 变化的事件一行 `{"seq":n,"add":[...],"remove":[...]}`（增量补丁，非全表）；省略 `--patch` 时写 stdout。
- 出错时 stderr 输出 `{"code","message"}` 并以非 0 退出（领域错误 exit 1，用法/IO 错误 exit 2），已产生的补丁仍会落盘。

## 事件

| type      | 字段 | 说明 |
|-----------|------|------|
| `account` | `budget`, `quoteTtl`, `worstRate{ccy}`, `frozen{ccy}` | 总风险预算、报价有效期、各币最坏估计汇率上限、各币已冻结额（可多次合并） |
| `payment` | `id`, `amount`, `ccy`, `rate`, `ts` | `rate: null` 表示待报价（pending） |
| `quote`   | `paymentId`, `rate`, `ts` | 报价到达，触发重评估 |
| `freeze`  | `paymentId`, `ts` | 确认冻结，做预算与报价新鲜度校验 |
| `reverse` | `paymentId`, `ts` | 撤销冻结，释放预算 |

## 语义

- **pending 非不可满足**：`rate = null` 的付款只是待报价；报价事件到达后重评估，转入 eligible 或 rejected。
- **风险预算聚合**：`已确认敞口（账户各币冻结额 + 已 freeze 付款敞口）+ pending 最坏估计（amount × worstRate[ccy]，未配置视为 ∞）+ 本笔敞口 ≤ budget`，边界等于预算可通过；超限 freeze 失败，报 `E_BUDGET`。
- **报价新鲜度**：`now - quoteTs > quoteTtl` 视为过期；过期报价的 freeze、或 ts 早于当前报价的 quote 报 `E_RATE_STALE`。
- **eligibleSet 增量维护**：payment/quote/freeze/reverse/account 事件后重算并输出 add/remove 补丁；reverse 释放预算后，此前因预算被挤出的付款可重新进入 eligibleSet。

## 错误码

`E_BUDGET`（预算超限）、`E_RATE_STALE`（报价过期/旧报价）、`E_INVALID`（事件非法，如重复 id、冻结 pending 付款）、`E_IO`（输入文件不可读）。

## 布局

- `xborder` — CLI 入口；`src/cli.js` — 参数解析与 IO；`src/engine.js` — 核心引擎（纯内存、可测）
- `test/engine.test.js` — 验收 A/B/C 与错误路径；`test/cli.test.js` — CLI 端到端；`test/enumeration.test.js` — 验收 D 枚举对照
