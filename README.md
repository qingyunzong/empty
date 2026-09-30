# fpbound — binary64 浮点表达式误差界分析器

用 `Fraction` 精确模拟每次运算后的 round-to-nearest-even 舍入到 IEEE 754
binary64，并沿表达式树传播保守的绝对误差上界。

## 用法

```sh
echo '{"op":"add","left":{"const":0.1},"right":{"const":0.2}}' | python -m fpbound
```

stdin 读入 JSON 表达式树，stdout 输出每个节点的：

- `exact`：精确实数值（Fraction 字符串）
- `rounded`：实际计算出的 binary64 值（精确表示，或 `inf`/`-inf`/`nan`）
- `bound`：保守绝对误差上界，恒不小于真实误差 `|rounded - exact|`
- `status`：`ok` / `overflow` / `div_zero` / `invalid`

表达式树格式：叶子 `{"const": <number|string>}`，内部节点
`{"op": "add"|"sub"|"mul"|"div", "left": ..., "right": ...}`。

## 误差界传播规则

设子节点误差界为 `e_a, e_b`，局部舍入误差 `r = |rounded - v|` 精确已知：

- 加/减：`e_a + e_b + r`
- 乘：`|a_r|·e_b + |b_r|·e_a + e_a·e_b + r`
- 除：`(|b_r|·e_a + |a_r|·e_b) / (|b_r|·|b_exact|) + r`

除零（含除数下溢为 0）与溢出到 inf 时输出状态标记，`bound` 为 `inf`，
不崩溃。

## 测试

```sh
python -m unittest discover -s tests -v
```
