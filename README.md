# counterlib

带位宽累计计数器读数的区间增量计算库，仅依赖 Go 标准库。

## 规则

- 输入为 `Sample{Time, Value, Reset, Version}`：累计读数仅低 `Bits` 位有效（高位自动截断）。
- 同一时刻的重复采样取 `Version` 最高者；版本相同取先出现者。
- 显式重置标记（`Reset=true`）：该时刻之前区间的增量不可推得，输出未知；重置值成为后续区间的新基线。
- 读数下降时，仅在 `AllowWrap=true` 时按恰好一次回卷补模（`delta = (cur - prev) mod 2^Bits`）；否则该区间输出未知。
- 绝不推测多次回卷：补模至多一次，真实增量超过模时只输出一次补模后的结果。
- 输出为按时间升序的 `Interval{From, To, Delta, Known}` 列表，`Known=false` 表示未知区间。

## 测试

- `TestHandwrittenBoundaries`：14 个手写边界用例（递增、回卷补模、禁止回卷、多次回卷不推测、显式重置、重复时刻版本仲裁、乱序输入、1 位与 64 位计数器、高位截断、空输入、单一有效采样）。
- `TestReconstructionModel`：随机生成带真值的采样流（4 个种子 × 8 种位宽 × 50 步，含随机重置与重复时刻注入），与独立的重建模型（排序法实现）及真实增量逐区间对照。

## 实际运行结果

```
$ go test ./... -count=1
ok  	counterlib	0.008s
```
