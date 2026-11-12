# 带否定区段的采集事件关联

遥测分析宿主调用可导入的Go关联包发现A后B且中间无C的模式，D为非负整数，事件类型仅A、B、C；事件含key、类型、唯一ID和int64时间，可乱序。对同key每个A匹配严格晚于A且不晚于A加D的首个B，时间平局按ID字节序；若闭区间[A时间,B时间]存在C则该A不输出，B可被多个A复用。水位W承诺后续时间不小于W，仅W严格大于A加D后按A时间和ID交付已确定结果，数学整数避免溢出，结束等于正无穷。同ID同内容幂等，相同ID异内容及违约拒绝且状态不变。以全量事件排序参考测边界C和迟到首B。

## 用法

```go
import "example.org/dataeng/q0190"

// D 为非负窗口；NewCorrelator 接受 math/big.Int，NewCorrelatorInt64 为便捷构造。
c, err := dataeng.NewCorrelatorInt64(10)

// 乱序摄入事件；同 ID 同内容幂等，同 ID 异内容或迟到事件返回错误且状态不变。
_ = c.Ingest(dataeng.Event{Key: "host-1", Type: dataeng.TypeA, ID: "a1", Time: 0})
_ = c.Ingest(dataeng.Event{Key: "host-1", Type: dataeng.TypeB, ID: "b1", Time: 5})

// 水位严格推进；仅当 W 严格大于 A 时间 + D 后，Drain 才交付该 A 的确定结果。
_ = c.AdvanceWatermark(big.NewInt(11))
results := c.Drain() // 按 (A 时间, A 的 ID 字节序) 排序，仅含新确定结果

// End 等价于水位正无穷，确定并交付全部剩余结果；之后摄入/推进水位返回 ErrClosed。
rest := c.End()
```

## 语义要点

- 匹配窗口为半开时间关系 `A.t < B.t <= A.t + D`，同时间候选 B 取 ID 字节序最小者。
- 闭区间 `[A.t, B.t]` 内出现同 key 的 C 即抑制该 A；C 仅按 key 隔离，B 可被多个 A 复用。
- 所有时间加减与比较使用 `math/big`，int64 边界（如 `MaxInt64 + D`）不溢出。
- 哨兵错误：`ErrInvalidD`、`ErrUnknownType`、`ErrEmptyID`、`ErrDuplicateConflict`、
  `ErrLateEvent`、`ErrWatermarkBackwards`、`ErrClosed`。
- `correlator_test.go` 覆盖边界 C、迟到首 B、平局、复用、违约与溢出；
  `reference_test.go` 以全量事件排序参考实现做随机属性对照。
