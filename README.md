# jsonnum

精确十进制的 JSON 数字取整 CLI 与列级累计舍入库（Go，仅标准库）。

## 功能

- **精确解析**：JSON 数字解析为 `符号 × 尾数(big.Int) × 10^指数`，指数全程十进制精确计算，不经过 float64。
- **最近偶数舍入**：`Quantize(n, scale)` 输出 `round-half-even(n × 10^scale)` 整数；负零（`-0`、`-0.000`）输出 `"0"`。
- **指数界限**：字面量指数字段 `|e| ≤ 1000`，越界拒绝并报告所在下标（不丢位置），退出码为 1。
- **列级累计舍入**：`cumround` 保证前 k 项输出之和等于前 k 项精确和的最近偶数舍入；每项输出为相邻累计舍入值之差。撤回任一行时前缀差量不变、后续差量重算。

## CLI 用法

```sh
jsonnum -scale 2 [-mode convert|cumulative] < numbers.json
```

输入为 JSON 数字数组，输出为整数字符串的 JSON 数组（避免精度损失）。

- `-mode convert`（默认）：每个数独立舍入到 `scale` 位小数对应的整数。
- `-mode cumulative`：输出列级累计舍入的逐项差量。

```sh
$ echo '[1.005, -0, "2.5e1"]' | jsonnum -scale 2
["100","0","2500"]
$ echo '[0.005, 0.005, 0.005]' | jsonnum -scale 2 -mode cumulative
["0","1","1"]
$ echo '[1e1001]' | jsonnum
jsonnum: index 0: exponent 1001 out of range in "1e1001" (|e| must be <= 1000)
```

## 包

- `decimal`：JSON 数字精确解析、`Quantize`（最近偶数舍入）、有理数参考实现 `RoundRatHalfEven`。
- `cumround`：`Deltas`（全列）、`State`（分块/增量）、`Withdraw`（撤回一行并重算后续差量）。

## 测试

```sh
go test ./...
```

测试要点：

- 枚举十进制半值（各 scale 下恰落在 .5 边界的值及其 ±1 ulp 邻值、带指数移位）与有理数参考核验。
- 随机字面量（指数 ∈ [-1000, 1000]）模糊对照有理数参考。
- 分块处理与一次性全列计算对照；随机撤回与全量有理累计重算对照。
