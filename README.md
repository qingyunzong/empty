# binary64 浮点表达式误差界分析器

输入 JSON 表达式树（加减乘除与常数），用 `Fraction` 精确模拟每次
round-to-nearest-even 舍入到 binary64（IEEE 754 双精度），并传播保守的
绝对误差上界。

## 用法

```sh
echo '{"op":"add","left":{"const":"0.1"},"right":{"const":"0.2"}}' | python3 analyzer.py
```

- 输入（stdin）：表达式树 JSON。
  - 常数节点：`{"const": "0.1"}`（字符串/数字，字符串支持 `"1/3"`、`"1e308"`）
  - 运算节点：`{"op": "add|sub|mul|div", "left": ..., "right": ...}`
- 输出（stdout）：`{"root": <id>, "nodes": [...]}`，每个节点含：
  - `exact`：实数精确值（分数字符串，未定义时为 `null`）
  - `rounded`：binary64 舍入值（`"inf"`/`"-inf"`/`"nan"` 表示特殊值）
  - `bound`：绝对误差上界（分数字符串，`"inf"` 表示无界）
  - `status`：`ok` / `div_by_zero` / `overflow` / `unbounded`

## 语义

每个节点记录三元组：精确值 `E`、舍入值 `R`、误差界 `B`，保证
`|R - E| <= B`。设子节点舍入值为 `r1, r2`、误差界为 `b1, b2`：

- 节点在舍入后的子值上精确计算 `C = op(r1, r2)`（Fraction），再舍入
  `R = fl(C)`；舍入误差 `|R - C|` 用 Fraction 精确求得。
- 传播误差 `|C - E|` 的上界：
  - 加减：`b1 + b2`
  - 乘：`|r1|*b2 + (|r2|+b2)*b1`
  - 除：`(b1*M2 + M1*b2) / (|r2|*m2)`，其中 `Mi = |ri|+bi`，
    `m2 = |r2|-b2`；若 `m2 <= 0` 则界为无穷（`unbounded`）
- 总界 `B = |R - C| + 传播上界`，恒保守。

除零、溢出到 `inf`、精确值未定义等情况输出状态标记与 `bound: "inf"`，
不会崩溃。

## 测试

```sh
python -m unittest discover -s tests -v
```

覆盖：(a) 1000 个不超过 8 节点的随机表达式，验证界恒不小于用 Fraction
算得的真实误差；(b) 除零与溢出的状态输出；(c) 灾难性抵消案例界显著放大。
