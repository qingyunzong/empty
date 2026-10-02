# causal-history

单机离线 Node.js 22 库与 CLI：基于精确有理数运算判定设备事件的因果历史。

## 模型

- 事件：`id`、本地时间区间 `[a, b]`、时钟校正多项式 `f(t) = c0 + c1*t + c2*t^2`，所有系数为分数。
- 校正后全局区间精确计算：候选点为 `f(a)`、`f(b)`；当 `c2 != 0` 且顶点
  `t* = -c1 / (2*c2)` 落在 `[a, b]` 内时，额外计入 `f(t*)`。
- 有理数接受整数、小数字符串、`"p/q"` 或 `{num, den}`；分母为 0 报 `E_RATIONAL`，`a > b` 报 `E_RANGE`。

## 判定

- `before`：`hi(x) < lo(y)`（或经区间序 + 显式 happens-before 约束的链可达）。
- `after`：对称。
- `concurrent`：区间重叠或相切且无约束路径；未知不会被当作不可满足。
- `linearizations`：`n <= 7` 时按 id 字典序枚举全部可行线性化；无解返回 `E_UNSAT`。
- 证书：`interval`（含两端点与顶点）、`chain`（区间/约束混合链）、`overlap`（重叠区间）。

## CLI

stdin 读入一个 JSON（`{"commands": [...]}`、裸数组或单条命令），stdout 输出单行 JSON。

```
echo '{"commands":[{"op":"add_event","id":"e1","a":0,"b":10,"f":[0,1,0]},
{"op":"add_event","id":"e2","a":5,"b":15,"f":[0,1,0]},
{"op":"query","x":"e1","y":"e2"},{"op":"linearizations"}]}' | node src/cli.js
```

操作：`add_event` / `correct` / `add_constraint` / `undo` / `redo` / `query` / `linearizations` / `snapshot`。
非法多项式（如分母为 0）在落库前校验失败，历史不变。

## 测试

```
node --test
```
