# labelpack

离线产品标签包库与 CLI。Node.js 22，仅使用标准库，测试基于 `node:test`。

标签字段：GTIN、批次、序列号、工位、时间戳。

## 文件格式（`labels.plp`）

```
文件头   'PLPK' u16le 版本 u16le 标志                       (8 字节)
块序列   字典块 / 记录 delta 块，可随机访问
索引     'IDX1' u32le 数量, 条目*, u32le crc32
尾部     u64le 索引偏移, 'PLPKEND1'                        (16 字节)

块       u8 类型 | u32le 字典版本 | u32le 负载长度 | 负载 | u32le crc32
         crc32 覆盖 9 字节块头 + 负载（zlib.crc32）
索引条目 u64le 偏移 | u32le 长度 | u8 类型 | u32le 版本   (17 字节)
```

- **字典块**：`u32 版本 | u32 条目数 | [u8 字段标签 | u16 长度 | UTF-8 字节]*`。
  高频字段（gtin / batch / workstation）写入字典；条目 id 即块内序号。
  字典只能追加新版本（完整快照），旧记录永远绑定旧版本。
- **记录 delta 块**：`u32 字典版本 | i64 基准时间ms | u32 记录数`，
  每条记录 `u32 gtinId | u32 batchId | u32 workstationId | i32 时间差ms | u16 序列号长度 | 序列号字节`。
  记录对高频字段只引用字典 id；序列号内联；时间戳存相对块基准的 delta。
- **清单**：`manifest.json` 记录当前字典版本。新增字典版本先写
  `.manifest.json.<pid>.tmp`，fsync 后 `rename` 覆盖，原子生效。

## 解码

`IncrementalDecoder` 按块增量处理字节流：不完整的块被缓冲，只有完整且
CRC 校验通过的块才会解码其中的字符串，因此多字节 UTF-8 字符即使在
喂入边界（块边界）被切断，也不会产生乱码或丢字符。记录引用在整流
结束后统一解析，所以损坏的旧字典只影响绑定它的记录。

错误码：

| 代码 | 含义 |
| --- | --- |
| `E_DICT` | 字典块损坏（CRC 失败或负载非法），及依赖损坏字典的记录块 |
| `E_CRC` | 记录块损坏（CRC 失败或负载非法） |
| `E_DICTREF` | 引用未知字典版本、未知条目 id 或字段类型不符 |
| `E_FORMAT` | 容器结构错误（魔数、索引、截断等） |

## CLI

```sh
node src/cli.js init <dir>
node src/cli.js dict <dir> --set '{"gtin":["06..."],"batch":["L1"],"workstation":["包装线α"]}'
node src/cli.js append <dir> --labels '[{"gtin":"06...","batch":"L1","serial":"SN-1","workstation":"包装线α","timestamp":"2026-10-07T08:00:00Z"}]' [--auto-dict]
node src/cli.js dump <dir>      # 规范化 JSON（NFC、ISO-8601 UTC、固定键序）
node src/cli.js verify <dir>    # 有错误时退出码为 1
node src/cli.js blocks <dir>    # 随机访问索引
```

## 库 API

- `createPack(dir)` / `addDictionary(dir, values)` / `appendLabels(dir, labels, {autoDict})`
- `decodePack(dir)` → `{ labels, errors, dictionaries, index }`
- `dumpLabels(dir)` → 规范化标签数组
- `IncrementalDecoder`：`push(chunk)` / `end()`，逐块产出事件
- `readIndex(dir)` / `decodeRecordBlockAt(dir, blockPosition)`：随机访问

## 测试

```sh
node --test
```
