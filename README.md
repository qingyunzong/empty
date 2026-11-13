# HyperLogLog 世代合并

指标管线需要可导入的 Go HLL++ 状态库，支持 sparse/dense 表示、不同 precision 输入和显式 hash seed。只有 seed 相同的 sketch 可合并；降 precision 按寄存器映射进行，不能升精度伪造信息。序列化稳定，合并满足交换结合且误差用固定数据集验证。

## 用法

库代码在 `hll/` 包（导入路径 `example.org/dataeng/q0106/hll`），仅依赖标准库。

```go
s, _ := hll.New(14 /* precision */, 0x9E3779B97F4A7C15 /* hash seed */)
s.Add([]byte("user-123"))
est := s.Estimate()

data, _ := s.MarshalBinary()   // 稳定二进制格式，可跨进程/版本复现
var back hll.Sketch
_ = back.UnmarshalBinary(data)

low, err := s.ReducePrecision(10) // 只允许降精度；升精度返回 ErrPrecisionIncrease
err = s.Merge(other)              // seed 或 precision 不同会报错
```

- sparse 编码（25-bit 稀疏精度）在条目开销超过 dense 寄存器数组时自动切换为 dense。
- `Merge` 要求相同 seed 与 precision；跨精度先对高精度一侧调用 `ReducePrecision`。
- 合并基于寄存器 max / 有序集并集，满足交换律与结合律。
- 误差界约为 `1.04 / sqrt(2^precision)`，测试用固定数据集在 4σ 界内验证。

运行测试：`go test ./...`
