# settle

结算库：按输入有理汇率换算逐行金额，先逐行半偶舍入再合计；退款重算原
订单剩余项并做差。仅使用 Go 标准库（`math/big`）。

## 管线（顺序固定）

1. 行金额 = 单价 × 数量（精确有理数）
2. 优惠按明确顺序应用：
   1. 行级百分比优惠（按切片顺序）
   2. 行级定额优惠（按切片顺序，钳制到 0）
   3. 订单级百分比优惠（按切片顺序，作用于每一行）
   4. 订单级定额优惠（按切片顺序，按各行当前金额比例精确分摊）
3. 每行乘以有理汇率 `Rate`（目标货币 / 源货币）
4. 每行在 `Scale` 位小数处做半偶（银行家）舍入
5. 合计 = 各**已舍入**行金额之和

## 退款

`Refund(original, returned)` 用相同汇率、精度与优惠重算剩余商品的结算，
退款额 = 原订单合计 − 剩余订单合计（两者均为已舍入合计），避免按行
外推造成的舍入漂移。

## 舍入证据

每个 `LineResult.Rounding` 输出：

- `exact_num/exact_den`：换算后精确值（归一化分子/分母）
- `scaled_num/scaled_den`：精确值 × 10^scale
- `quotient`：向零截断的商；`remainder_num/remainder_den`：被舍弃的分数
- `half_cmp`：`2*|remainder|` 与 1 的比较（-1/0/+1）
- `rule`：`exact` / `down` / `up` / `tie-to-even`
- `rounded_num`（分母为 10^scale）

结果均可 JSON 序列化；总额以归一化 `total_num/total_den` 及十进制
`total` 输出。

## 独立核对

`model_test.go` 用 `math/big.Rat` 独立重实现整条管线（不依赖库内任何
实现），对固定样例与 500 组随机订单（含随机退款）逐行、逐总额交叉核对，
并校验舍入证据内部一致性（`scaled == quotient + remainder/den`）。

## 运行

```
go test ./...
```
