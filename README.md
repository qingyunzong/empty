# 描述符编译与解码子集

模块路径为 `example.org/dataeng/q0298`，包名为 `dataeng`。实现只依赖标准库，
不下载或嵌入外部 BUFR 表。输入由宿主显式提供：

- `[]Descriptor{F,X,Y}`，`F=0..3`、`X=0..63`、`Y=0..255`；
- `ElementTable`：F=0 的基础位宽、整数 scale、任意精度有符号 reference；
- `SequenceTable`：F=3 的原始描述符列表；
- 非负子集数 `S`；
- MSB 先行的 `BitString`。

## 接入调用例

可运行版本见 `examples/integration/main.go`：

```bash
go run ./examples/integration
```

核心调用如下：

```go
import (
    "math/big"
    de "example.org/dataeng/q0298"
)

temperature, _ := de.NewElementDef("air-temperature", 8, 1, big.NewInt(0))
elements := de.ElementTable{{X: 1, Y: 1}: temperature}

// 1-01-000, 延迟因子 0-31-001, 复制体中的一个原始描述符 0-01-001。
root := []de.Descriptor{
    {F: 1, X: 1, Y: 0},
    {F: 0, X: 31, Y: 1},
    {F: 0, X: 1, Y: 1},
}
template, err := de.Compile(root, elements, nil)

// 因子=2，两个 8 位观测，最后有 3 个全 0 填充位。
bits, _ := de.NewBitString("00000010" + "00010100" + "00011001" + "000")
observations, err := template.Decode(bits, de.DecodeOptions{
    Subsets:         1,
    MaxObservations: 10,
    MaxSteps:        10,
    MaxDepth:        1,
})
```

`Decode` 按执行顺序返回 `Observation`：

```go
type Observation struct {
    Subset   int          // 1 起
    Element  ElementID    // X/Y 与可选 Name
    Path     []PathStep   // 活跃 F=3 / F=1 层；复制迭代号 1 起
    BitStart int          // 0 起，含
    BitEnd   int          // 0 起，不含
    Raw      uint64
    Missing  bool
    Value    *big.Rat     // canonical rational；Missing 时为 nil
}
```

重复出现的元素每次产生独立观测，不覆盖。`ElementID.Descriptor()` 可还原 F=0
标识。`Observation.RationalString()` 输出 `"n"`、`"n/d"` 或 `"missing"`。

## 已实现的语义

- F=0 读取无符号 `u`；有效位宽全 1 为 missing；否则精确值为
  `(u + reference) * 10^(-有效scale)`。reference 不变，scale 为
  基础 scale 加当前 scale 偏移。
- F=1 的 `X` 是紧随的原始描述符位置数，不是序列展开后的叶数。
  `Y>0` 按固定次数执行；`Y=0` 后必须紧跟 `0-31-001`（8 位因子）或
  `0-31-002`（16 位因子）。因子不计入该复制的 `X`，不作为观测，也不受
  操作符影响；因子全 1 非法，因子 0 合法。
- 复制体包含嵌套复制时，外层 `X` 覆盖嵌套描述符、其专用因子和复制体的
  原始位置。边界切断嵌套因子或复制体时编译失败；不会先全展开再数 `X`。
- F=2 仅支持 `X=1` 位宽偏移和 `X=2` scale 偏移。`Y=0` 清除，`Y=1..255`
  设为 `Y-128`（是设置值，不是累加）。操作符不占数据位。
- 操作符状态在一个子集内全局有效。序列/复制退出不恢复旧偏移，各次复制
  沿用上一次结束状态；每个新子集开始时两个偏移都清 0。
- 有效位宽只在元素实际执行时检查为 `1..64`。零次复制体不执行，故其中
  的非法有效位宽不会在运行时触发；但结构和定义仍会在编译时检查。
- 子集之间从上一子集结束位继续，不字节对齐。所有子集结束后，只允许
  少于 8 位的全 0 尾填充。
- 编译检查所有可达结构、引用、元素定义和序列递归环；序列环即使在零次
  复制体中也拒绝。

## 预算与原子性

`DecodeOptions` 中三个上限都是含上界，`-1` 表示不限制：

- `MaxObservations`：已选择输出观测的最大数量；
- `MaxSteps`：实际执行 F=0/F=1/F=2/F=3 每次计一步，读取延迟因子另计一步；
- `MaxDepth`：当前活跃 F=3 展开与 F=1 复制体层数，根深度为 0。

零次复制仍计执行该 F=1 描述符一步。`Select` 只抑制观测输出；未选元素依旧
检查有效位宽、读取位流并推进位位置，操作符也照常执行。任何位置发生错误时，
`Decode` 返回 `nil, error`，不发布该消息的部分结果。

## 独立展开参考

`internal/refexp` 是不复用生产编译器的小规模结构展开器。它用显式叶数组和
调用者提供的因子读取器，独立展示原始 X 位置计数、序列/复制路径和上限行为，
仅用于审计与测试；生产解码器不使用它，也不构造巨量展开数组。

## 测试

```bash
go test ./...
go vet ./...
```

测试覆盖嵌套延迟因子、`X` 与展开叶数不同、序列内操作符影响外部、跨子集
偏移复位、零次复制不改变状态、选择输出不改变解码、非零尾填充，以及原子
失败、编译期未执行分支校验、精确有理数和 missing。
