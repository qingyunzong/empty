# lzwcli — LZW 编解码 CLI

仅使用 Go 标准库实现的 LZW 压缩/解压命令行工具，支持字典检查点与范围解码。

## 码流格式

- **初始字典**：码 0–255 固定映射到单字节字面量；码 256 为清空码（clear code）；
  257 起为压缩过程中动态添加的字典项。**无终止码**：码流在码边界结束，
  末尾用零比特补齐到整字节。
- **位宽增长**：码按 LSB-first 打包。位宽从 9 位开始，每当"下一个待分配码"
  达到 `1<<width` 时增长 1 位，上限 16 位。字典满（下一码将超过 65535）时，
  编码器以当前 16 位宽发出清空码并重置字典。
- **解码自引用**：当读到的码恰好等于下一个待分配码时，其展开为
  `prevString + prevString[0]`（KwKwK 情形）。
- **错误**：读到超出范围的非法码报 `invalid code`；末码之后存在非零填充位
  或 ≥8 位的多余位报 `trailing bits`；字典已满却未收到清空码报
  `dictionary overflow`。

## 检查点与范围解码

`Decoder.Checkpoint()` 在任意两个码之间捕获完整状态：

| 字段 | 含义 |
|---|---|
| `CodeIndex` | 已消费的码数 |
| `BitPos` | 位游标（源中的比特位置） |
| `Width` | 当前码宽（可能落在位宽增长前后） |
| `Next` | 下一个待分配码 |
| `Generation` | 清空码代数，每次清空 +1 |
| `PrevCode` | 上一个码（恢复续解码所需） |
| `Digest` | 完整字典摘要（SHA-256，含全部字典项与代数） |

`Resume(src, cp, end)` 从源开头重放到 `cp.CodeIndex` 并**核对源前缀**：
重放得到的状态（含字典摘要与代数）与检查点完全一致才继续解码，否则报
`checkpoint does not match source prefix`。由于摘要覆盖清空码代数与全部字典项，
清空码之后的旧检查点无法套用到新字典上。`DecodeRange(src, start, end)` 解码
码区间 `[start, end)` 的输出。

## 用法

```sh
go build -o lzw .
./lzw encode  [-o out] [in]              # 压缩（默认 stdin/stdout）
./lzw decode  [-o out] [in]              # 解压
./lzw range -start N [-end M] [-o out] [in]   # 只解码码区间 [N, M)
./lzw checkpoints [-every N] [in]        # 打印每个码边界的检查点
```

## 测试

```sh
go test ./...
```

覆盖：字典刚满（下一码恰好到 65535 时发清空码）、自引用（含清空后）、
独立编码器逐字节互验、非法码/尾部多余位/字典溢出报错、位宽增长边界
（索引落在增长前后）、枚举全部暂停点恢复、随机范围与从头解码核对、
清空码前后检查点隔离、异源流/篡改前缀拒绝。

实际运行结果（Go 1.27.1, linux/amd64）：

```
ok  	lzwcli/lzw	28.539s
```

全部 13 个测试通过：

```
--- PASS: TestEnumeratePauses (10.71s)
--- PASS: TestCheckpointAcrossWidthGrowth (0.00s)
--- PASS: TestRandomRanges (12.14s)
--- PASS: TestCheckpointRejectsForeignPrefix (0.21s)
--- PASS: TestCheckpointAcrossClear (0.00s)
--- PASS: TestRoundTrip (0.07s)
--- PASS: TestSelfReference (0.00s)
--- PASS: TestInvalidCode (0.00s)
--- PASS: TestTrailingBits (0.00s)
--- PASS: TestIndependentEncoder (0.56s)
--- PASS: TestDictJustFull (0.83s)
--- PASS: TestWidthGrowthBoundary (0.00s)
--- PASS: TestDictOverflow (0.67s)
```
