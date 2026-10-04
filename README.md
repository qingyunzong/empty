# order-cancel-machine

Node.js 22（仅标准库 + `node:test`）实现的交易撤单因果状态机库与 CLI。

## 模型

- 委托状态：`NEW` → `CANCELED` / `MATCHED`，并发冲突时为 `CONFLICT`。
- 每个事件（`create`/`cancel`/`match`/`resolve`）携带：`orderId`、`eventId`、
  `prevHash`（哈希链）、向量时钟 `clock`，整体 SHA-256 哈希。
- 因果规则：
  - 撤单因果先于成交 → 成交被拒绝（`already-canceled`），合并后该成交事件为 void。
  - 成交因果先于撤单 → 撤单被拒绝（`already-matched`），合并后该撤单事件为 void。
  - 撤单与成交并发（向量时钟不可比较）→ 合并为 `CONFLICT`，两个事件都保留。
- 裁决：`resolve` 事件的时钟必须支配冲突双方（即观察到冲突）才生效，
  状态迁移到裁决指定状态；`cert` 输出证书（裁决依据：决策、理由、裁决人、
  双方事件 ID、裁决事件哈希）。冲突未裁决时证书 `valid: false`。

## CLI

```sh
node cli.js [--db orders.json] [--replica A] <command>

create <orderId>                              # 创建委托（NEW）
cancel <orderId>                              # 撤单；已成交 -> {"error":"already-matched"}
match  <orderId>                              # 成交；已撤单 -> {"error":"already-canceled"}
resolve <orderId> <CANCELED|MATCHED> --reason R --by W
merge  <file>                                 # 合并另一副本的存储文件
state  <orderId>                              # 输出委托状态 JSON
cert   <orderId>                              # 输出证书 JSON（含 valid 字段）
```

- 所有输出为 JSON；错误输出 `{"error":"code"}` 且退出码为 1。
- 存储文件也可用环境变量 `ORDER_DB` 指定，副本 ID 用 `REPLICA`。

## 库

- `src/machine.js` — 纯函数 `reduceOrder(events)`，由事件集推导状态。
- `src/clock.js` — 向量时钟：`happensBefore` / `concurrent` / `mergeClocks`。
- `src/event.js` — 规范化 JSON 与事件哈希/校验。
- `src/store.js` — 存储文件读写、事件签发、副本合并。

## 测试

```sh
node --test --test-reporter spec > result.txt 2>&1; echo $? >> result.txt
```

- `test/machine.test.js` 枚举撤单/成交在两副本上的全部偏序
  （cancel<match、match<cancel、concurrent × 发起副本组合 × 到达顺序），
  与独立的参考表状态机对照；并覆盖裁决必须观察到冲突双方的规则。
- `test/cli.test.js` 覆盖三条验收路径及错误包络/退出码。
