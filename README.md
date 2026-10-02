# causal-settlement-ledger

单机结算因果台账库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 模型

- 每个副本维护一个 JSON 数据库文件：`{replica, clock, frontier, events}`。
- 事件：`{type: "settle"|"adjust", paymentId, amount, clock, prev, hash}`。
  - `clock`：副本向量时钟；本地追加时合并时钟并将本副本分量加一。
  - `prev`：追加时的 frontier（哈希链 / 因果前驱）。
  - `hash`：对 `{type, paymentId, amount, clock, prev}` 的规范化 JSON 做 SHA-256。
- 副本间通过 `dump` 导出的 JSON 文件交换事件，`merge` 增量合并。

## 语义

- 事件断言其付款的完整新余额；有因果先后的事件按序计算，后者生效。
- 并发（向量时钟不可比较）且金额不同的事件记为冲突，绝不静默选值；
  冲突付款不出现在 `balances` 中。
- `merge` 校验：缺直接前置 → `unknown-predecessor`；事件时钟已被本地
  合并时钟覆盖（时钟回退）→ `stale-clock`；内容哈希不符 → `bad-hash`。
  合并是原子的：任一事件失败则整批不生效。
- 只有引用齐备且无冲突时，`cert` 才输出最终性证书
  `{frontier, entriesHash, balances}`，否则报错 `conflict`。

## CLI

```sh
node src/cli.js append --db a.json --replica A --type settle --payment p1 --amount 100
node src/cli.js append --db a.json --type adjust --payment p1 --amount 150
node src/cli.js dump  --db a.json                 # 导出事件供其他副本 merge
node src/cli.js merge --db b.json --replica B --file dump.json
node src/cli.js cert  --db a.json
```

正常结果以 JSON 输出到 stdout；错误输出 `{"error":"code"}` 到 stderr，
退出码为 1。

## 测试

```sh
node --test
```

测试包含：三条验收场景；两副本三条消息的全部 19 种偏序 × 全部合法
副本归属 × 全部拓扑投递顺序，用独立参考函数（直接从偏序推导因果关系、
冲突与余额，不经过向量时钟）逐例对照；以及 CLI 端到端用例。
