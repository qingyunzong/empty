# event-causal-history

设备事件因果历史判定库与 CLI（Node.js 22，单机离线，零依赖）。

## 模型

- 事件：`id`、本地时间区间 `[a, b]`、时钟校正多项式 `f(t) = c0 + c1·t + c2·t²`，系数全为有理数。
- 校正后全局区间是 `[a, b]` 在 `f` 下的精确像：`c2 ≠ 0` 且顶点 `t* = -c1/(2·c2)` 落在 `[a, b]` 内时计入顶点值，否则只取端点。全部用 BigInt 分数精确计算。
- 有理数输入形式：整数、十进制小数、字符串 `"p/q"`、或 `{"num": p, "den": q}`；输出统一为 `"p/q"` 字符串。

## 判定

- `compare(x, y)`：`hi(x) < lo(y)`（精确区间）或存在 happens-before 约束链 → `before` / `after`；否则 `concurrent`。证书给出区间端点（含顶点）或约束链。区间与约束互相矛盾 → `E_UNSAT`。
- `linearize(ids?)`：`n ≤ 7` 时规范枚举全部可行线性化（字典序、去重）；并发事件两序皆出，未知不当作不可满足；组合序存在环 → `E_UNSAT`；`n > 7` → `E_TOO_LARGE`。
- 错误码：分母为 0 → `E_RATIONAL`；`a > b` → `E_RANGE`；未知事件 → `E_UNKNOWN_EVENT`；重复导入 → `E_DUPLICATE_EVENT`。

## 历史

- `importEvent` / `correct` / `constrain` 均可 `undo` / `redo`；新操作清空 redo 栈。
- 非法多项式（如分母为 0）的更正被拒绝且历史完全不变。

## CLI

```sh
echo '{"ops":[{"op":"import","id":"e1","a":0,"b":10,"f":{"c1":1}},
              {"op":"import","id":"e2","a":5,"b":15,"f":{"c1":1}},
              {"op":"compare","x":"e1","y":"e2"},
              {"op":"linearize"}]}' | node bin/cli.js
```

stdin 为 JSON（`{"ops":[...]}`、单个 op 或 op 数组），stdout 为单行 JSON `{"results":[...]}`；stdin 非法时输出 `{"error":"E_PARSE",...}` 并以退出码 1 结束。op 列表见 `bin/cli.js` 头部注释。

## 测试

```sh
node --test
```
