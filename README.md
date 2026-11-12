# 采集浮点值的最短往返十进制契约

本包 `example.org/dataeng/q0324` 把 binary64 的原始 `uint64` 位型转换成规范的、语言无关的十进制证书。

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0324"
)

func main() {
	bits := uint64(0x3fb999999999999a) // 0.1
	r := dataeng.Format(bits)
	fmt.Println(r.Text)              // 1e-1
	fmt.Println(r.Tuple())           // 1 1 -1
	fmt.Println(r.Interval.Lower)    // exact rational endpoint
	fmt.Println(r.RoundTrip)         // true
	if err := dataeng.Verify(r); err != nil {
		panic(err)
	}
}
```

`Format` 返回 `Result`：

- `Sign`, `C`, `Q` 组成 `Sign*C*10^Q`；`C` 为正整数，无前导零且不被 10 整除。
- `Text` 是固定科学表示，例如系数 125、指数 -2 写成 `1.25e0`。
- 有限值的 `Interval` 是带符号的精确有理数舍入区间，含 `LowerClosed`/`UpperClosed`。
- `Bits` 始终保存完整输入；NaN 的 `Text` 为 `nan`，`RoundTrip=false`，`NaNPayload` 保存低 52 位 payload。
- 正负零为 `0e0`/`-0e0`，无穷为 `inf`/`-inf`。

`Verify` 从原始位型重新构造精确区间，检查证书与规范文本，并用整数界和精确有理数比较证明不存在更短系数，也证明同位数没有更近或更优决胜候选。它不借助 `strconv.ParseFloat` 试探最短性。

生产路径只使用 `math/big.Int`、`math/big.Rat` 和整数文本格式化，不调用浮点格式化/解析库。实现按有效位数递增，在每一档用精确整数区间定位少量候选，不枚举 10^17 个系数。
