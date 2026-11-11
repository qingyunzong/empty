# q259 字幕位图解码组件

可导入的 Go 包（module `example.com/dlks/q259`），把由对象定义、调色板
版本、显示列表与结束标记组成的流解码为预乘 RGBA 画布（`*image.RGBA`）。

## 流协议

- **对象定义**：以 `(对象ID, 版本)` 标识，可分片到达。每片带 `Offset`
  与固定的 `TotalLength`；重叠区间的字节必须逐字节一致，否则返回
  `ErrInconsistentFragment`。同一 ID 的新旧版本彼此独立、可交错到达。
  拼接后的定义为大端 `uint16 width`、`uint16 height` 加游程数据。
- **游程**：每行由若干 `(count, index)` 字节对组成；`count==0` 为单字节
  行结束标记（其后不跟 index）。行有效像素必须恰好等于 `width`，行数
  恰好等于 `height`；行宽不足、超长、缺行、多行、残缺游程一律
  `ErrInvalidObject` 拒绝。
- **调色板版本**：`Palette` 按 `Version` 存储 256 色与一个透明索引
  （`TransparentIndex`，-1 表示无）。
- **显示列表**：`DisplayList` 固定引用 `(对象ID, 对象版本, 调色板版本)`
  及放置坐标；登记后引用的对象与调色板即被钉住，防止缓存回收。
- **结束标记**：`End()` 仅在全部对象分片到齐、调色板齐备时合成。透明
  索引像素跳过、不覆盖底图；任一对象坐标越界则整次拒绝
  （`ErrOutOfBounds`），不产生部分画面。合成成功后清除待显示列表，
  缓存的对象与调色板保留。

## 用法

```go
d := q259.NewDecoder()
d.SetCacheLimit(64) // 可选：LRU 上限，被显示列表钉住的条目不回收

// 分片到达（可乱序、可重叠，重叠内容必须一致）
_ = d.AddObject(q259.ObjectFragment{
	ID: 7, Version: 1, TotalLength: totalLen, Offset: off, Data: chunk,
})
_ = d.AddPalette(pal)
_ = d.SetDisplayList(&q259.DisplayList{
	Width: 1920, Height: 1080,
	Objects: []q259.DisplayObject{
		{ObjectID: 7, ObjectVersion: 1, PaletteVersion: 1, X: 10, Y: 20},
	},
})

img, err := d.End() // 齐备并收到结束标记后得到预乘 *image.RGBA
```

错误均为哨兵错误的包装值，用 `errors.Is` 判定，例如
`ErrNotReady`、`ErrOutOfBounds`、`ErrInconsistentFragment`、`ErrPinned`。

## 测试

`go test -race ./...` 覆盖：新旧版本交错、游程跨片（单字节分片切断
字节对）、重叠一致性、行宽不足/超长/缺行/多行、越界整次拒绝、预乘
source-over 混合、齐备门控，以及 LRU 回收不破坏被钉住的待显示列表。
