# 贸易融资托管放款生命周期判定

Node.js 22，仅标准库，离线单机。库 `lib.js` + CLI `cli.js`，JSONL 事件驱动。

## 机制

- 请求需提交人 + 两名不同审批人（审批人不得为提交人本人，重复审批无效 `E_DUPLICATE`）。
- 审批权沿部门 DAG 继承：审批人所在部门是请求部门的祖先（含自身）即有权限，否则 `E_AUTH`。
- 冲突优先级：合规冻结 > deny > allow。冻结期间新审批/否决仅记录（held）不生效；
  解冻后按原时间戳继续判定，解冻迁移的 cause 中列出原 ts。
- 撤销审批仅限放款前，由本人或上级（撤销人部门是被撤销人部门的真祖先）执行，否则
  `E_REVOKE_AUTH`；放款/否决后任何变更报 `E_FINAL`。
- 状态机：`NONE → PENDING → FROZEN → (DISBURSED | DENIED)`，DISBURSED/DENIED 为终态。
- 审计哈希：sha256 链 `h = sha256(h | canonical(event) | outcome)`，输出于 `final.json`。

## 事件（JSONL，首行必须为 config）

```json
{"type":"config","departments":{"dept":["parent"]},"people":{"user":"dept"}}
{"type":"submit","request":"r1","by":"alice","dept":"tf_ops","amount":100,"ts":1}
{"type":"approve","request":"r1","by":"bob","ts":2}
{"type":"deny","request":"r1","by":"carol","reason":"...","ts":3}
{"type":"freeze","request":"r1","by":"erin","reason":"...","ts":4}
{"type":"unfreeze","request":"r1","by":"erin","ts":5}
{"type":"revoke","request":"r1","by":"carol","target":"bob","ts":6}
```

## 运行

```sh
node cli.js events.jsonl final.json   # 输入错误写 stderr 并以退出码 1 终止
node --test                           # 运行全部测试
```

输出 `final.json`：`requests`（各请求终态与审批明细）、`transitions`（状态迁移及原因）、
`failures`（业务规则失败及错误码）、`audit_hash`。
