# 模式升级的最小拒收反例

接入模式升级前需证明旧合法记录不会被新模式拒绝。本包（`package dataeng`，module
`example.org/dataeng/q0169`）供宿主直接调用，在一个有限模式域上做全域穷举，
返回最小拒收反例；不存在反例时返回结构化的包含证明。

## 支持的模式形状

- 对象至多 8 个具名字段，字段名必须唯一，未知字段一律拒绝。
- `IntegerEnum`：有界整数枚举，可声明 `Nullable`；枚举值序列由调用方给定。
- `EnumArray`：枚举整数数组，`MinItems/MaxItems` 有界且 `MaxItems <= 3`，数组不可空。
- 每个字段可 `Required` 或缺省；缺省字段在记录中没有键，`missing` 从不作为值输出。

## 宿主 API

- `Check(old, new *Schema) (*Result, error)`：全域穷举入口，默认上限 500 万条。
- `CheckWithLimit(old, new, limit)`：显式指定穷举上限；域大小超限直接报错，不抽样。
- `Accept(schema, record)`：单条记录的接受判定与拒收原因，含未知字段检查。
- `DomainSize(schema)`：解析公式计算的有限域大小，与实际穷举计数互相印证。
- 值构造器：`NullValue()`、`IntValue(v)`、`ArrayValue(elems...)`；
  `Record` 是 `map[string]Value`，JSON 序列化按键名字典序输出。

```go
old := &dataeng.Schema{Fields: []dataeng.FieldSpec{
    {Name: "mode", Kind: dataeng.IntegerEnum, Nullable: true, Enum: []int{0, 1}},
}}
new := &dataeng.Schema{Fields: []dataeng.FieldSpec{
    {Name: "mode", Kind: dataeng.IntegerEnum, Enum: []int{0, 1}},
}}
res, err := dataeng.Check(old, new)
// res.Counterexample.Record.String() == {"mode":null}
```

## 最小反例的次序

全域按下列全序流式枚举，第一个被新模式拒绝的旧合法记录即最小反例：

1. 出现字段数少者优先（空记录最先）。
2. 字段数相同，按键名排序后的键名序列做字典序比较，例如 `["a"] < ["a","b"] < ["b"]`。
3. 键名序列相同，按字段名顺序逐字段比较类型化值：
   - 整数枚举：`null` 最小，其余按调用方给定枚举切片的下标（rank）比较，不按数值大小；
   - 枚举数组：先比长度，再逐元素按枚举 rank 比较。

因此两份仅枚举值顺序不同的模式会产生不同的最小反例，测试
`TestEnumOrderDrivesValueOrder` 固定了该行为。

## 包含证明

穷举未发现反例时返回 `Proof`，包含：

- `OldDomainSize` 与 `Checked`：旧域记录总数及实际核验条数，二者相等即覆盖全域；
- `FieldFacts`：逐字段证据，覆盖新增必填、null 收紧、枚举收窄、数组长度上下界变化、
  字段删除与新增可选字段等情况。

测试用例分别核验了新增必填（`{}`）、null 收紧（`{"a":null}`）、数组 `MaxItems`
收紧（长度 3 的数组）、`MinItems` 收紧（空数组）以及枚举收窄，并含一个 8 字段
最大形状的全域交叉核验。
