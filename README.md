# machining-scheduler

有限域机加工排程库与 CLI（Node.js 22 标准库，无依赖）。

## 模型

每道工序选择机床、整数槽位与刀具：

```json
{
  "machines": ["M1", "M2"],
  "tools": [{ "id": "T1", "life": 90 }],
  "fixtures": ["F1"],
  "horizon": 12,
  "slotMinutes": 10,
  "dueSlot": 8,
  "operations": [
    { "id": "op1", "machines": ["M1"], "minutes": 40, "fixture": "F1", "tools": ["T1"], "due": 8 }
  ]
}
```

- `minutes` 为切削分钟数，槽位时长 = `ceil(minutes / slotMinutes)`。
- 约束：同机工序不重叠；每把刀累计切削分钟数 ≤ `life`；同一夹具同一时刻只服务一道工序。
- 目标：最小化总超期步数 `sum(max(0, end - due))`。

## 求解

有限域回溯 + 分支定界：赋机床/槽位/刀具，传播累计刀具寿命与夹具/机床互斥
（前向检查域瓦解与刀具剩余寿命下界）。结果：

- `optimal`：最小超期步数与全部赋值；
- `infeasible`：附带工序—刀具/夹具冲突证明（`proof`）；
- `unknown`：节点预算耗尽，附未决量（`pending`）。

`replaceOperation(instance, committed, opId, newOp)`：先层级回滚被替换工序触发的
槽位/刀具/夹具传播（其余已确定赋值保持不变），再增量加入新工序求解。

## CLI

```sh
node src/cli.js schedule <instance.json> [--budget N]
node src/cli.js replace <instance.json> --op <id> --with <new-op.json> [--budget N]
```

退出码：`0` 正常（含 infeasible/unknown 结果）；`1` 运行时错误；
`2` 非法整数、未知刀具/机床/夹具等用法错误。

## 测试

```sh
node --test
```
