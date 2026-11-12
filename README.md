# 指数直方图跨精度与零桶闭包合并

这个 Go 包供遥测采集管线合并同一度量的非负整数计数直方图。它不接触原始样本、
不假设桶内均匀分布，只做降尺度聚合、零桶阈值闭包和容量检查。时间窗、报表、
告警、原始样本映射以及 sum/min/max 都不在本包范围内。

## 数据模型

`scale` 是 `[-8,8]` 的整数，桶边界为
`B(s,i)=2^(i*2^(-s))`，索引 `i` 表示 `(B(s,i),B(s,i+1)]`。正、负两侧都按
绝对值分桶，负侧数组的索引顺序与正侧完全相同；正负方向由调用方解释，本包
不会交换负侧索引。

```go
type Group struct {
    Offset int32
    Counts []uint64
}

type Histogram struct {
    Scale     int
    Positive  Group
    Negative  Group
    ZeroCount uint64
    Threshold Threshold
    Count     uint64
}
```

`Threshold` 既可以是字面值 0，也可以是 `2^(N/2^K)`。零值
`Threshold{}` 实际表示 `2^0=1`；零阈值请使用 `dataeng.NewZeroThreshold()`。
`NewThreshold(n,k)` 会将其约分为规范形式。`K` 必须在 `[0,16]`。

输入校验包括：

- `scale`、偏移加数组末尾索引、空数组 `offset=0` 的 int32 范围规则；
- `Count == ZeroCount + sum(Positive) + sum(Negative)`，任一步溢出即拒绝；
- 非零普通桶的下边界必须 `>=` 输入 threshold；零计数桶可以跨阈值；
- threshold 为 0 时，所有普通桶都合法。

## 合并 API

```go
result, err := dataeng.Merge(histograms, maxDenseSpan)
```

`Merge` 从所有输入 scale 的最小值开始向下尝试到 `-8`，返回第一个满足两侧
闭包后跨度限制的候选。每个候选都从原始输入重新计算，不复用失败候选已经吸收
零桶后的中间结果。`MaxDenseSpan` 必须在 `[2,4096]`。

固定候选操作：

```go
fixed, err := dataeng.MergeAtScale(histograms, scale, maxDenseSpan)
combined, err := dataeng.CombineAtScale(histograms, scale)
```

`MergeAtScale` 在指定 scale 执行同样的闭包与容量检查。`CombineAtScale` 不施加
跨度限制，返回一个可在同一 scale 再次参与合并的规范 `Histogram`。

输出桶只裁掉首尾零计数；中间零桶会保留，因此跨度按首尾非零索引计算。空输入
`Merge(nil, M)` 返回 `scale=8`、零阈值、空桶和 `count=0`。

## 精确阈值闭包

- 旧索引 `i` 降到目标 `t` 时精确映射为 `floor(i/2^(s-t))`；负索引用数学
  向下取整。
- 初始 `T` 是所有原始 threshold 的最大值。
- 若有非零桶满足 `lower < T < upper`，把 `T` 提升到这些桶 `upper` 的最大值，
  重复到没有跨界桶。
- 随后把 `upper <= T` 的整桶计数移入 `ZeroCount`。`upper == T` 吸收，
  `lower == T` 不吸收，绝不拆分桶；`T=0` 不吸收普通桶。
- 所有边界、threshold 和提升结果都通过精确二进制有理指数比较，不使用浮点
  对数，也不会实际计算巨大的幂值。

## 调用示例

```go
inputs := []dataeng.Histogram{
    {
        Scale:     0,
        Positive:  dataeng.Group{Offset: 0, Counts: []uint64{1, 2}},
        Threshold: dataeng.NewZeroThreshold(),
        Count:     3,
    },
    {
        Scale:     1,
        Positive:  dataeng.Group{Offset: 0, Counts: []uint64{4, 0, 6}},
        Threshold: dataeng.NewZeroThreshold(),
        Count:     10,
    },
}

merged, err := dataeng.Merge(inputs, 4096)
if err != nil {
    // errors.Is(err, dataeng.ErrInvalidInput)
    // errors.Is(err, dataeng.ErrCountOverflow)
    // errors.Is(err, dataeng.ErrCapacity)
    return err
}
// merged.Scale == 0
// merged.Positive == Group{Offset: 0, Counts: []uint64{5, 8}}
// merged.Count == 13
```

可运行的示例见 `example_test.go`。

## 错误区分

- `ErrInvalidInput`：scale、偏移、threshold、count 一致性或普通桶阈值规则非法；
- `ErrCountOverflow`：输入求和或合并中间计数发生 uint64 溢出；
- `ErrCapacity`：到 `-8` 仍无法满足跨度。此时返回 `*CapacityError`，其中包含
  `PositiveSpan`、`NegativeSpan` 和 `MaxSpan`，结果是零值而非部分成功。

## 参考实现

`reference` 子包提供一个独立的小规模展开实现
`reference.MergeAtScale`。它先分配目标索引范围，再逐个枚举落入目标桶的旧索引，
不复用生产路径的 map 聚合、跨度计算或闭包辅助函数，用于测试交叉核对。

## 分组一致性

对固定的候选 scale，`CombineAtScale` 的闭包满足分组一致性：先分组、
再在同一 scale 合并，与一次合并所有输入得到相同直方图。测试覆盖了这一点。

自适应 `Merge` 会为每个分组独立选择最高可行 scale，因此不能宣称其最终结果
在任意分组顺序下总与一次合并相同。测试中保留了一个明确的反例，说明先自适应
分组可能改变最终 scale 和 threshold。

## 验证

```sh
go test ./...
go vet ./...
```

测试覆盖精确有理指数比较、`-1/-2` 负索引降尺度、负侧吸收、跨界阈值提升、
`lower==T`/`upper==T`、零阈值、内部大空洞、输入置换、固定尺度分组一致性、
计数溢出以及 `-8` 仍超容量等边界。
