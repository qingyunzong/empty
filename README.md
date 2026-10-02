# wxblk — 气象观测追加式块流（离线校验 / 增量解码 / 更正撤销）

Node.js 22，仅标准库，无依赖。测试使用 `node:test`。

## 文件格式

```
文件头:  "WXBLK001" (8 字节魔数)
块:      块头(72B) | payload | CRC32C(4B) | 索引脚注(32B)
```

块头（小端）：块魔数 `'BLK1'`、版本、类型（0=data / 1=correction / 2=undo）、
块 id(u64)、时间戳(u64 ms)、`replacesId`(u64，无则为 0xFFFF…F)、payload 长度、
`prevHash`(32B)。CRC32C（Castagnoli）覆盖块头+payload。
每块索引脚注记录 `{blockId, offset, blockLen}` 及自身 CRC，供反向扫描与索引校验。
全局 hash 链：`blockHash = sha256(块头‖payload)`，每块块头携带前一块的 hash，
创世 hash 为 `sha256(文件魔数)`。

## 语义

- `append`：追加 data 块。
- `correct(id, newPayload)`：不原地修改，追加 correction 块并通过 `replacesId`
  链接被替换块（可链接 data 块或另一个 correction 块）。同一根记录的最新有效
  更正决定视图值。
- `undo(correctId)`：追加 undo 块。若某有效更正直接依赖（`replacesId == correctId`）
  或该更正已被撤销，则报 `ERR_CONFLICT`；id 不存在或不是更正则报 `ERR_RANGE`。
- `scan`：顺序扫描重建索引，与索引脚注比对并报告差异（`indexDiffs`）；
  CRC 坏块标记 `crcOk:false` 但继续扫描；截断尾部记入 `truncated`。
- `verify`：校验魔数、CRC（坏块跳过并列入 `crcErrors`）与 hash 链；
  链断抛 `ERR_CHAIN`，魔数/块魔数错误抛 `ERR_FORMAT`。
- `decode(range)`：由完整有效块重建最终视图；`--from/--to` 为视图记录下标
  （含端点），`--since/--until` 按时间窗过滤；非法区间报 `ERR_RANGE`。

## CLI

```
node cli.js append  <file> --payload STR [--payload-file P] [--ts MS]
node cli.js correct <file> --id N --payload STR [--payload-file P] [--ts MS]
node cli.js undo    <file> --correct-id N [--ts MS]
node cli.js scan    <file>
node cli.js verify  <file>
node cli.js decode  <file> [--from N --to N] [--since MS --until MS]
```

成功结果输出 JSON 到 stdout；错误输出 JSON 到 stderr
（`{"error":"ERR_FORMAT|ERR_CRC|ERR_CHAIN|ERR_RANGE|ERR_CONFLICT", ...}`），退出码非 0。

## 测试

```
node --test
```

覆盖验收项：追加-更正-撤销解码对照、字节翻转定位块号、块中/块边界截断的
确定性恢复差异、小数据随机操作暴力重放对照最终视图。真实输出见 `RESULTS.md`。
