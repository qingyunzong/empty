# reconcile

对账匹配库与 CLI（Node.js 22，仅标准库 + node:test）。

## 模型

- 输入为银行分录与账务分录（`{id, amount}`，金额按分取整）。
- `suggest` 事件把分录加入分录池并生成候选，分两个分支：
  - `exact`：一条银行分录对一条或多条账务分录，总金额精确相等；
  - `fee`：尾差 `|diff| <= tolerance` 且非零，差额计为手续费更正（`fee`，单位：分）。
- 候选编号确定性分配：先 `exact` 分支后 `fee` 分支，各自按（银行 id 升序，账务子集 bitmask 升序）。
- 候选汇合时按编号升序贪心选择；引用同一银行/账务分录即冲突，编号较小者保留（`suggested`），另一个被拒绝（`rejected`），其未被占用的分录仍可复用。
- `confirm` 确认建议中的候选；`undo` 撤销确认，释放全部分录并回滚手续费更正。
- 所有事件追加持久化到 `<workdir>/events.jsonl`，重放产生相同的状态哈希（匹配证书）。

## 事件

```json
[
  {"type": "suggest", "bank": [{"id": "B1", "amount": 100}],
   "ledger": [{"id": "L1", "amount": 60}, {"id": "L2", "amount": 40}], "tolerance": 0},
  {"type": "confirm", "candidateId": 1},
  {"type": "undo", "candidateId": 1}
]
```

## CLI

```
node cli.js <events.json> <workdir>
```

标准输出为含 `matches`、`corrections`、`stateHash` 的 JSON；失败时退出码为 1，
标准错误为标准 JSON 错误体 `{"ok": false, "error": {"message": ...}}`。

## 测试

```
node --test
```
