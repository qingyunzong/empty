# ptag-pack

离线产品标签包库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

标签字段：`gtin`、`batch`（批次）、`serial`（序列号）、`station`（工位）、`time`。

## 文件格式

```
magic "PTP1"
block*                       顺序块
index block (type=3)         随机访问索引（自身也是带 CRC 的块）
footer                       u64 indexOffset + u32 indexCrc + "PTPE"
```

每个块：`u8 type | u32 payloadLen | u32 crc32(payload) | payload`。

- **字典块 (type=1)**：`u32 version` + 全量快照条目 `{field, id, utf8 value}`。
  高频字段（gtin / batch / station）写入字典；字典只追加新版本，旧记录永远
  绑定写入时的旧版本。新字典版本先写清单临时文件再 `rename` 生效
  （`<file>.manifest.json.tmp` → `<file>.manifest.json`）。
- **记录块 (type=2)**：`u32 dictVersion` + `i64 baseTimeMs` + 记录序列。
  记录只存字典 id；时间为相对 baseTime 的 zigzag varint delta；序列号内联。

## 解码

- `Decoder`（`src/decoder.js`）：按块增量处理，`feed(chunk)` 接受任意切分
  的字节块——多字节 UTF-8 字符可跨块拆分，不产生乱码或丢字符。
- `readPack`（`src/reader.js`）：经尾部索引随机访问逐块校验解码。

错误码：字典损坏 `E_DICT`；记录块损坏 `E_CRC`；引用未知字典 id/版本 `E_DICTREF`。
损坏的旧字典只影响绑定它的记录，使用新字典的记录仍可正常解码。

## CLI

```
node cli.js pack <out.ptp> <tags.json>   # 打包 JSON 标签数组
node cli.js enum <file.ptp>              # 逐行输出规范化 JSON（键序固定，time 为 ISO）
node cli.js verify <file.ptp>            # 完整性校验，有错误时退出码为 1
node cli.js dict <file.ptp>              # 显示字典清单
```

## 测试

```
node --test
```
