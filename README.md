# xborder — 跨境结算额度引擎与 CLI

Node.js 22，仅标准库，无网络、无真实汇率。测试：`node --test`。

## 用法

```sh
xborder run events.jsonl --patch out.jsonl
# 或：node bin/xborder.js run events.jsonl --patch out.jsonl
```

逐行读取事件，把 eligibleSet 的**变化补丁**（而非全表）追加写入 `--patch` 文件，
每行一个 `{"seq","event","op":"add"|"remove","id"}`。出错时向 stderr 输出
`{"code","message"}` 并以非零码退出（已产出的补丁保留）。

## 事件（JSONL）

```json
{"type":"account","budget":1000,"worstRates":{"USD":2}}   至多一次；缺省预算 Infinity
{"type":"payment","id":"p1","amount":100,"ccy":"USD","rate":null,"rateTs":0}
{"type":"quote","paymentId":"p1","rate":1.5,"ts":1}
{"type":"freeze","paymentId":"p1"}
{"type":"reverse","paymentId":"p1"}
```

## 语义

- `rate: null` 表示**待报价（pending）**，不等于不可满足：可先冻结，按
  `amount * worstRates[ccy]`（缺省 1）的最坏估计上限占用预算。
- 风险预算聚合 = 已确认敞口（已冻结且汇率已知）+ pending 最坏估计上限；
  冻结会使聚合超过预算时失败，报 `E_BUDGET`（状态不变）。
- 报价按到达事件重评估：`ts` 必须严格大于当前 `rateTs`，否则 `E_RATE_STALE`。
  对已冻结的付款按实际汇率重算：放得下转 eligible（补丁 `add`）；
  放不下则 rejected 并回滚冻结释放预算（若曾 eligible 则补丁 `remove`）。
- `reverse` 撤销冻结、释放预算（若在 eligibleSet 中则补丁 `remove`）；
  对未冻结付款为幂等空操作。rejected 为终态。

## 结构

- `src/engine.js` — 增量引擎：运行中维护 confirmed/pendingWorst 聚合与 eligibleSet，逐事件产出补丁。
- `src/reference.js` — 独立参考实现：每次预算检查从零扫描重算，补丁由前后 eligibleSet 差分得出。
- `src/cli.js` / `bin/xborder.js` — CLI。
- `test/` — 验收 A/B/C（`engine.test.js`）、CLI（`cli.test.js`）、
  验收 D 全子集对照（`enumeration.test.js`，8 事件池的全部 256 个子集）。
