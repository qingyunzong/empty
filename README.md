# 采集批次的精确小数类型归并

数据导入宿主调用Go类型推断包，为多批记录推断统一数值列模式。单元格只允许null或十进制字符串，语法为可选负号、至少一位整数、可选小数点及至少一位小数，不接受指数和空白。去掉整数前导零但保留至少一个零；保留小数末尾零，精度定义为整数有效位数与小数位数之和，负零保留数值零。统一scale取所有非null值的最大小数位数，统一precision取最大整数有效位数加scale，超过调用方上限即拒绝整个新批次，旧状态不变。返回每行按统一scale表示的任意精度带符号整数及原始scale；扩展scale时已经交付的批次须通过新的不可变视图重解释，旧视图保持原模式和原值。全null列模式未定。测试不同批次提升、负零、精度恰好上限及拒绝后再接收，核对原数值及原始小数位数能无损恢复。

## 包 API

- `NewColumn(maxPrecision int) *Column`：创建列，precision 上限为调用方约束。
- `(*Column).AppendBatch(cells []string) (*View, error)`：整批先校验后提交；
  语法错误返回 `*CellError`，超 precision 上限返回 `*LimitError`（分别包装
  `ErrInvalidCell` / `ErrLimitExceeded`），拒绝时旧状态与旧视图不变。
- `View` 为不可变快照：`Schema()` 返回 `Schema{Precision, Scale, Defined}`，
  `Row(i)` 返回 `Row{Value *big.Int, OriginalScale int}`，其中 `Value` 是按视图
  统一 scale 放大的任意精度带符号整数，null 行为 `nil`。
- `View.Restore(i)` 按 `OriginalScale` 还原规范化后的原始十进制字符串（保留小数
  末尾零、负零输出为 `0`），null 行返回 `NullCell`。
- 全 null 列 `Schema().Defined == false`，模式未定；首次出现非 null 值后才定型。

## 用法

```go
col := dataeng.NewColumn(10)

v1, err := col.AppendBatch([]string{"12.3", "0.5", dataeng.NullCell})
// v1.Schema() = {Precision:3 Scale:1 Defined:true}

v2, err := col.AppendBatch([]string{"1.250"})
// v2.Schema() = {Precision:5 Scale:3 Defined:true}
// v1 仍保持 scale=1 与原值；v2 把历史行重解释为 scale=3

row := v2.Row(0)            // 12.3 -> Value=12300, OriginalScale=1
_ = v2.Restore(0)           // "12.3"，原始数值与小数位无损恢复
```
