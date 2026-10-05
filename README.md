# lzwcli

LZW 编解码 CLI 与库（仅依赖 Go 标准库）。位格式为 GIF 变体，与
`compress/lzw`（LSB 位序、8 位字面量）完全兼容：

- 初始字典：256 个字面量码（0–255），256 为清空码，257 为终止码（EOF）。
- 码宽从 9 位起步，字典每填满一档（512→1024→2048→4096）增长 1 位，上限 12 位。
- 字典填满（hi 达到 4095）时编码器发出清空码，字典与码宽重置后重建。
- 解码器处理 `code == hi` 的下一编号自引用情形（展开为上一码展开 + 其首字节）。

## 错误

- `ErrMissingEOF`：位流在终止码之前耗尽（无终止码）。
- `ErrInvalidCode`：出现解码器尚未定义的非法编号。
- `ErrTrailingBits`：终止码之后存在多余字节或非零填充位。

## 检查点与范围解码

`Checkpoint` 保存位游标、码宽、下一编号、输出长度、源前缀摘要
（SHA-256）与完整字典摘要（SHA-256，覆盖全部存活字典项）。恢复时从
头快进到检查点的位游标，重新导出字典并逐项核对：源前缀被篡改、套用
其他流的检查点、或清空码之后字典已重建而沿用旧检查点，都会被
`ErrCheckpoint` 拒绝。`DecodeRange(data, start, end, cp)` 解码码区间
`[start, end)` 的输出，`SelectCheckpoint` 选取不超过 start 的最新检查点。

## 用法

```sh
go build ./cmd/lzw
lzw encode -o out.lzw in        # 压缩（默认 stdin -> stdout）
lzw decode -o out in.lzw        # 解压
lzw range -start 100 -end 300 in.lzw   # 解码码区间 [100,300) 的输出
lzw checkpoints -every 1000 in.lzw     # 每 1000 个码打印一个检查点
```

## 测试

```sh
go test ./...
```

测试覆盖：与标准库 `compress/lzw` 双向互验、字典刚好填满（hi == 4095）
并触发清空码、自引用码、三类错误、枚举每个暂停点的断点续解、随机范围
解码、码宽增长点前后的检查点、跨清空码的检查点隔离。
