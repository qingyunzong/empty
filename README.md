# recstream

按记录读取混合编码字节流的 Go 库（仅使用标准库）。

## 流格式

- 流由记录组成，记录以 `U+000A`（当前编码下的换行符）终止；最后一条记录可省略终止符。
- 编码声明即 BOM：UTF-8 `EF BB BF`、UTF-16LE `FF FE`、UTF-16BE `FE FF`。
- 声明**只能**出现在记录边界（流起始或记录终止符之后），用于切换后续记录的编码；记录内部解码出的 `U+FEFF` 视为非法的中途编码切换，返回错误。
- 非法字节序列、过长编码、UTF-8 编码的代理项、孤立/截断的 UTF-16 代理对均返回 `*DecodeError`（含绝对字节偏移），绝不静默替换为 U+FFFD。

## API

- `NewDecoder(initial ...Encoding)`：增量解码器，默认初始编码 UTF-8。
- `Write([]byte)` / `Close()`：以任意大小的块喂入输入，BOM、多字节序列、代理对可跨块拆分。
- `Next() (Event, error)`：逐事件（声明 / 码点 / 记录结束）返回，每个事件携带原始字节范围 `[Start, End)`；输入不足返回 `ErrNeedMore`，解码错误具有粘性。
- `Collect(d)` / `ReadAll(r)`：将事件聚合为 `Record`，`Record.Points` 保留每个码点的原始字节范围。

## 测试

```sh
go test ./...
```

实测结果（Go 1.27.1，linux/amd64）：`ok  recstream` —— 10 个测试全部通过，
其中 `TestArbitraryChunking` 以 1..30 字节的所有固定块大小重放混合编码流，
事件序列与字节范围完全一致；`TestDecodeErrors` 覆盖 12 类坏输入
（含记录内 BOM、孤立/截断代理项、过长编码），均按预期偏移报错。
