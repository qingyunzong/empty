# trajidx — 轨迹索引 CLI

为日志文件**旁路**生成行级索引（偏移 + 链式摘要），绝不修改原文件；
支持增量校验，在任意截断或更改后定位**首个不可信区间**，并与全扫描结果对照。
仅使用 Go 标准库。

## 构建与测试

```sh
go build ./...
go test ./...
```

## 用法

```sh
trajidx index  [-o index.tidx] <logfile>        # 生成旁路索引（默认 <logfile>.tidx）
trajidx verify [-i index.tidx] <logfile>        # 增量校验 + 全扫描对照
trajidx lookup [-i index.tidx] -n N <logfile>   # 按偏移随机读取第 N 行（1 起）
trajidx info   [-i index.tidx] <logfile>        # 查看索引摘要
```

`verify` 退出码：0 = 完全一致；3 = 截断/更改/追加；1 = 出错；2 = 用法错误。

## 设计

- **旁路索引**：索引写入独立的 `<logfile>.tidx`（临时文件 + rename 原子落盘），
  原文件只读打开，索引前后内容哈希不变（`TestSidecarDoesNotModifyOriginal`）。
- **链式前缀摘要**：每行记录 `{offset, length, digest}`，其中
  `digest[i] = SHA-256(digest[i-1] || 行字节)`，`digest[-1]` 为 32 字节零。
  校验时逐行重算链，首个摘要不匹配的行即为信任边界。
- **流式处理**：固定 32 KiB 缓冲（`bufio.ReadSlice` 分片），8 MiB 超长行、
  末行无换行、多字节 UTF-8 日志均按字节流处理；按 `'\n'` 字节切行对 UTF-8
  安全（0x0A 不会出现在多字节序列内部）。
- **增量校验**：`Verify` 在首个不可信行即停（实测 2 MB 文件中第 10 行损坏时
  仅读取约一个缓冲区）；`FullScan` 消费全流并统计全部不匹配，作为对照参照。
  两者对“可信前缀 / 首个不可信偏移”必须一致（`EqualTrust`），CLI 每次
  verify 都执行该对照。
- **判定**：
  - `ok`：完全一致；
  - `truncated`：文件短于索引大小（边界截断或行内截断，含多字节字符中间）；
  - `modified`：索引范围内摘要不匹配（含末行无换行时被追加内容的情形——
    此时最后一行确实被改动，如实报告）；
  - `appended`：索引前缀完好、尾部有新增字节（仅当原文件以换行结尾）。
- **不可信区间**：`[FirstUntrusted, end)`；截断/更改时 `end` 为索引文件大小，
  追加时 `end` 为当前文件大小。

## 索引格式（小端）

```
header: magic "TIDX" | version u16 | flags u16 | fileSize u64 |
        lineCount u64 | finalDigest [32]byte
record: offset u64 | length u32 | digest [32]byte   (每行一条，定长 44 字节)
```

## 测试结果（go test ./...，go1.27.1 linux/amd64）

```
ok  trajidx/tidx   12 个测试全部通过，包括：
  - 多字节日志偏移/摘要、末行无换行、8 MiB 超长行流式构建与校验
  - 截断（行边界/行内/多字节字符中间/空文件）首个不可信区间定位
  - 单字节更改（含新建/销毁换行符）首个不可信区间定位
  - 追加、空文件、增量提前终止、旁路不修改原文件、索引编解码往返
```
