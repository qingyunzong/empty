# order-cancel-causal-sm

Node.js 22（仅标准库 + node:test）实现的交易撤单因果状态机库与 CLI。

## 模型

- 本地副本维护委托状态：`NEW`、`CANCELED`、`MATCHED`，并发冲突时为 `CONFLICT`。
- 撤单 / 成交 / 裁决事件均含 `orderId`、`eventId`、`prevHash`（前置哈希链）与向量时钟 `clock`。
- 因果判定基于向量时钟：
  - 撤单因果先于成交 → 成交被拒绝（`already-canceled`），不持久化。
  - 成交因果先于撤单 → 撤单被拒绝（`already-matched`），不持久化。
  - 两者并发（无因果关系）→ 合并为 `CONFLICT`，两个事件都保留，绝不任选其一。
- `CONFLICT` 下仅当裁决事件的向量时钟覆盖（观察到）两个冲突事件时，状态才迁移到裁决指定状态；证书（cert）记录裁决依据（两冲突事件 ID 与哈希、理由）。未裁决时证书 `valid: false`。
- 归约（`reduceOrder`）是纯函数：同一事件集合任意到达顺序、任意合并方向得到同一状态。

## CLI

```sh
node src/cli.js [--db state.json] [--replica ID] <command>

create  <orderId>                          # 新建委托（NEW）
cancel  <orderId> [--event-id ID]          # 撤单
match   <orderId> [--event-id ID]          # 成交
resolve <orderId> --to CANCELED|MATCHED [--reason TEXT]
merge   <file>                             # 合并另一副本的状态文件
state   <orderId>                          # 查询状态
cert    <orderId>                          # 输出证书
```

- 输出为单行 JSON；错误输出 `{"error":"code"}` 且退出码为 1。
- `--db` 为副本持久化文件（也可用环境变量 `ORDER_DB`），`--replica` 指定副本 ID（默认 `replica-1`）。

## 测试

```sh
node --test --test-reporter spec > result.txt 2>&1; echo $? >> result.txt
```

`test/statemachine.test.js` 枚举撤单/成交在两副本（A、B）上的全部偏序
（cancel-first / match-first / concurrent × 事件所在副本），与独立参考表
`REFERENCE` 对照，并验证合并交换律、冲突双事件保留、盲裁决无效、合法裁决后证书有效。
`test/cli.test.js` 覆盖三条验收路径与错误码/退出码。
