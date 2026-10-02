# chargeback-ledger

收单行拒付资金回补路径判定库与 CLI。Node.js 22，仅标准库。

## 模型

- 商户 → 门店 → 终端组成层级树，节点含 `balance`（非负整数）与可选 `rule: {"liable": boolean}`。
- 责任规则沿层级继承：节点的有效规则为自身或最近祖先的规则，子级可覆盖父级；全树无规则时默认可承担。
- 拒付成立时从发生节点向上找首个可承担方，承担 `min(balance, 剩余额)`；余额不足则部分承担并继续向上。全链耗尽仍有缺口时按已扣减生效，结果码 `E_INSUFFICIENT`。
- 撤销拒付：校验原路径每步节点当前余额仍等于扣减后余额；任一层已变动则恢复失败（码 `E_RESTORE`），不做任何变更并保留审计；全部匹配则按原路径逆序回补。
- 同额多路径并列：覆盖额相同 → 起始节点层级浅者优先 → 节点 id 字典序。

## JSONL 输入

每行一个 JSON 对象，按序执行。父节点必须先于子节点定义。

```jsonl
{"type":"node","id":"m1","balance":1000,"rule":{"liable":true}}
{"type":"node","id":"s1","parent":"m1","balance":200}
{"type":"node","id":"t1","parent":"s1","balance":50}
{"type":"chargeback","id":"cb1","node":"t1","amount":150}
{"type":"chargeback","id":"cb2","candidates":["t1","t2"],"amount":40}
{"type":"reverse","id":"rv1","chargeback":"cb1"}
{"type":"route","id":"rt1","root":"m1","amount":40}
```

- `node`：建节点；`rule` 可省略。
- `chargeback`：`node`（确定发生节点）或 `candidates`（候选发生节点，按并列规则选路）二选一。
- `reverse`：按 `chargeback` id 撤销。
- `route`：干跑判定，不改余额；`root` 可省略（全图），返回按并列规则排序的全部候选路径与选中路径。

## 输出

`result.json` 含 `results`（每步承担额、恢复结果、失败码）、`balances`（终态余额）、`audit`（含失败的恢复尝试）。

结果码：`OK`、`E_INSUFFICIENT`（覆盖不足）、`E_RESTORE`（余额已变动，恢复失败）、`E_STATE`（重复撤销）。
输入错误（坏 JSON、未知节点、重复 id、非法金额等）写 stderr（`E_INPUT: ...`）并以退出码 1 终止。

## 使用

```sh
node cli.js case.jsonl result.json
node --test
```

## 库 API

`lib.js` 导出 `Ledger`（`addNode` / `chargeback` / `reverse` / `route` / `plan` / `enumeratePlans` / `balance(s)` / `audit`）、`comparePlans`、`applyOp`、`ChargebackError`。
