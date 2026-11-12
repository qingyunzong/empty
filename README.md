# 地理数据采集的混合字节序对象

空间数据接入宿主调用可导入的Go几何解码包，每对象有所有计数及类型使用当前对象字节序，嵌套对象各有自己的标记；字节序标记0大端或1小端及uint32类型：1点含两个float64，2折线含点数及点，3多边形含环数及每环点数和点，7集合含对象数及嵌套对象。坐标须有限，非空环至少4点且首尾坐标相等，零环表示空多边形；集合内可混字节序。限制总点数及深度，截断、尾随字节和计数超限整对象失败并给几何路径。用独立编码器和每字节切块验证。

## 二进制格式

每个对象以 5 字节头开始：

| 字节 | 内容 |
| --- | --- |
| 0 | 字节序标记：`0` 大端，`1` 小端 |
| 1..4 | `uint32` 几何类型，使用本对象的字节序 |

类型负载：

| 类型 | 负载 |
| --- | --- |
| `1` Point | 两个 `float64`（X、Y） |
| `2` LineString | `uint32` 点数，随后为各点 |
| `3` Polygon | `uint32` 环数；每环为 `uint32` 点数及各点 |
| `7` GeometryCollection | `uint32` 对象数，随后为各自带头部的嵌套对象 |

所有计数、类型和 `float64` 均使用所在对象的字节序。集合的每个成员可独立选择字节序。零环多边形是合法空多边形；非空环至少 4 点且首尾坐标完全相等。坐标必须是有限值。

## 使用

```go
package main

import (
	"errors"
	"fmt"

	"example.org/dataeng/q0132"
)

func main() {
	var data []byte // encoded geometry from the host
	geometry, err := dataeng.Decode(data)
	if err != nil {
		var decodeErr *dataeng.DecodeError
		if errors.As(err, &decodeErr) {
			fmt.Printf("geometry %s at byte %d: %v\n", decodeErr.Path, decodeErr.Offset, err)
		}
		return
	}

	switch geometry.Type {
	case dataeng.PointType:
		fmt.Println(geometry.Point.X, geometry.Point.Y)
	case dataeng.LineStringType:
		fmt.Println(len(geometry.Points))
	case dataeng.PolygonType:
		fmt.Println(len(geometry.Rings), geometry.PointCount())
	case dataeng.GeometryCollectionType:
		fmt.Println(len(geometry.Geometries))
	}
}
```

`Decode` 使用 `DefaultLimits`（最多 1,000,000 个点、集合深度 64）。需要自定义限制时使用 `DecodeWithLimits`、`NewDecoder(...).Decode` 或 `Decoder.Limits`。限制按整个顶层对象累计，包括所有嵌套集合成员。

失败时不会返回部分对象。`DecodeError` 暴露 JSONPath 风格的 `Path`、绝对字节偏移 `Offset`，并可通过 `errors.Is` / `errors.As` 检查 `ErrTruncated`、`ErrTrailingData`、`ErrPointLimit`、`ErrDepthLimit` 等哨兵错误。

## 测试

测试代码包含一个不依赖生产代码的独立编码器，并验证：

- 四种几何类型、两种字节序及集合内混合字节序；
- 空折线、空集合和零环空多边形；
- 对每个合法样例的所有字节前缀逐一验证截断失败；
- 尾随字节、坐标非有限、环点数与闭合校验；
- 总点数限制、深度限制和无法容纳的超大计数。

```sh
go test ./...
```
