# 日志接入的重复键保真对象

`dataeng` 是供日志采集宿主导入的 Go 解析包。它把 JSON 对象流解析成**有序键值对树**
（而非 `map`），完整保留标准库会丢失的信息。

## 保真与语义

- **重复键合法**：对象以 `[]Member` 保存，键顺序与每次重复都保留，不做去重。
- **类型化路径查询**：`FieldStep(字段, 出现序号)` 与 `IndexStep(下标)`。
  - 字段出现序号从 1 开始；`AllOccurrences`（即 0）选中该字段的全部重复。
  - 数组下标从 0 开始。
  - 路径缺失返回 `QueryResult{Found:false}`（`IsMissing()`），与显式的 JSON `null`
    （`Found:true` 且 `Kind == KindNull`）严格区分，绝不用 `null` 表达缺失。
- **数值双表示**：`Number.Lexeme()` 保留原词法；`Number.Rat()` 给出精确 `*big.Rat`。
  有理数由数字逐位构造，不依赖会急切展开大指数的 `big.Rat.SetString`。
- **字符串严格校验**：原始多字节内容按 UTF-8 增量校验（支持跨 chunk 的半截 rune），
  `\u` 转义强制配对高/低代理项，拒绝未配对代理、原始控制字符与非法转义。
- **重新编码**：`Encode` 紧凑输出、`EncodeIndented` 缩进输出；键顺序、重复次数与数值
  原词法保持不变，仅允许空白变化。

## 流式切块与预算

- `NewParser` + `Feed([]byte)` + `End()` 为增量状态机，`Feed` 可按**单字节**调用，
  字符串转义、多字节 UTF-8、数字与字面量均可跨 chunk 续接。
- 输入支持多个顶层值组成的对象流，结果通过 `Roots()` 按序取得。
- `End()` 在末尾截断（未闭合容器、未终止字符串、悬空转义、残缺数字）时返回
  `ErrIncomplete`。
- 调用方通过 `WithBudget(Budget{...})` 设定：
  - `MaxSignificantDigits`：尾数有效数字上限，超出返回
    `ErrSignificantDigitsExceeded`；前导零不计，尾随零计。
  - `MaxExponentExpansion`：有效十进制指数绝对值上限，超出返回
    `ErrExponentBudgetExceeded`，在任何大整数展开之前拒绝。
  - 任一项为 0 表示不限制；默认见 `DefaultBudget`。

## 用法

```go
p := dataeng.NewParser(dataeng.WithBudget(dataeng.Budget{
    MaxSignificantDigits: 200,
    MaxExponentExpansion: 10000,
}))
for chunk := range stream {
    if err := p.Feed(chunk); err != nil { return err }
}
if err := p.End(); err != nil { return err }

root := p.Root()
second := root.Query(dataeng.FieldStep("level", 2))
if second.IsMissing() { /* 缺失，而不是 null */ }

all := root.Query(dataeng.FieldStep("level", dataeng.AllOccurrences))
elem := root.Query(dataeng.FieldStep("items", 1), dataeng.IndexStep(0))

out, err := dataeng.EncodeIndented(root, "  ")
```

## 测试

`go test ./...` 覆盖：重复嵌套键与独立查询模型、逐字节切块与一次性解析等价、
调用方有效数字/指数预算超限拒绝、超大指数受限拒绝、末尾截断、UTF-8 与代理对严格校验、
以及重新编码对键顺序/重复次数/数值原词法的保真。
