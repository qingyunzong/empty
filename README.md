# PDF 表格跨页续接

报表采集器可直接导入 `example.org/dataeng/q0072`。输入每页已识别单元格、边线和页眉/页脚区域，输出一个或多个续接后的表格。

## 用法

```go
pages := []dataeng.Page{
    {
        Number: 1,
        Width: 600, Height: 800,
        Cells: []dataeng.Cell{
            {Text: "项号", Bounds: dataeng.Rect{X0: 40, Y0: 70, X1: 200, Y1: 100}, Header: true},
            {Text: "金额", Bounds: dataeng.Rect{X0: 200, Y0: 70, X1: 560, Y1: 100}, Header: true},
        },
        Borders: []dataeng.Border{
            {X0: 40, Y0: 70, X1: 560, Y1: 70},
            {X0: 40, Y0: 100, X1: 560, Y1: 100},
            {X0: 200, Y0: 70, X1: 200, Y1: 760},
        },
        HeaderRegion: dataeng.Rect{X0: 0, Y0: 0, X1: 600, Y1: 50},
        FooterRegion: dataeng.Rect{X0: 0, Y0: 760, X1: 600, Y1: 800},
    },
    // 下一页
}

tables := dataeng.Assemble(pages)
```

表头可由识别器用 `Cell.Header=true` 明确标记；未标记时默认把首行作为表头候选，可用 `WithAssumeFirstRowHeader(false)` 关闭。`AssembleWithWarnings` 同时返回无法挂到具体表格的页面级警告，表格级警告在 `Table.Warnings` 中。

## 判定规则

- 页眉/页脚区域内的识别对象视为页面家具，不进入表格碎片。
- 列几何比较列边界、表宽和左边距；列数不一致时不会续接。
- 表头签名按列比较规范化后的表头文本，支持多行表头和合并表头；正文行、合并单元格不参与文本相似度计算。
- 断行证据要求上一页碎片贴近页脚边界、下一页碎片贴近页眉边界，并参考闭合边线及不完整行。
- 证据不足或阈值未达到时保留为两个表，同时记录 `ambiguous_page_break` 警告。

## 输出与来源

- `Table.Header` 保存首次出现的表头。
- `Table.HeaderOccurrences` 保存每次表头出现；重复表头 `Removed=true`，但仍保留原始单元格、页码和碎片号。
- `Table.Pages` 保存每个参与页面的 `PageRef`。
- `Row.Partial`、`PageBoundary.RowSplit` 标记跨页断行；两个残行片段保持独立，不做文本拼合。
- `Cell.RowSpan`、`Cell.ColSpan` 原样保留几何合并信息。
- `Table.Confidence` 是各跨页边界置信度的最小值。

可调项包括 `WithMinConfidence`、`WithHeaderSimilarity`、`WithColumnTolerance`、`WithBreakTolerance`、`WithFragmentGapRows` 和 `WithTopOrigin`。

## 坐标

默认从页眉/页脚位置推断 y 轴方向：两者都存在时，页眉靠近的一侧为页顶。也可用 `dataeng.WithTopOrigin(true)`（OCR 常见，y 向下）或 `WithTopOrigin(false)`（PDF 常见，y 向上）显式指定。

## 测试

```sh
go test ./...
```
