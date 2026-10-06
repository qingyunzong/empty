# blockstore

Go 实现的分块压缩文件库，支持随机范围读取与端到端完整性校验。

## 文件格式

```
[header]        magic(8) version(4) blockSize(4)
[block record]* rawLen(4) compLen(4) crc32(4) flate压缩数据
[index]         magic(8) numBlocks(4) totalLen(8) 条目... rootHash(32) crc32(4)
[trailer]       indexLen(4) magic(4)
```

- 每个块独立 flate 压缩，块头带 CRC32；索引条目含偏移表（offset/compLen/rawLen）
  和每块解压数据的 SHA-256。
- 整文件哈希 = 各块哈希串联后的 SHA-256（rootHash），追加无需重哈希旧数据。
- 索引自身带 CRC32，文件末尾 8 字节 trailer 定位索引。

## 完整性语义

- **块损坏**：仅与损坏块相交的查询返回 `BlockCorruptError`，其余范围正常读取。
- **索引损坏**：`Open` 直接返回 `ErrIndexCorrupt`，所有查询被拒绝。
- **快照隔离**：`Open` 时加载索引快照；之后 `OpenAppend` 追加（旧索引保留在磁盘上）
  不影响已打开 reader 的长度与数据。
- `Verify()` 重读全部块，逐块校验 CRC + SHA-256，并复核整文件 rootHash。

## 用法

```go
w, _ := blockstore.Create("f.blk", 64*1024)
w.Write(data)
w.Close()

r, _ := blockstore.Open("f.blk")   // 索引快照
chunk, _ := r.ReadRange(off, n)    // 随机范围读
r.Verify()                         // 整文件校验

w2, _ := blockstore.OpenAppend("f.blk") // 追加，不污染旧快照
w2.Write(more)
w2.Close()
```

## 测试

```sh
go test ./...
```

覆盖：随机切片比对、逐块损坏隔离、索引各部位损坏全拒绝、追加与旧快照隔离、
逐字节截断（0..文件长度）无 panic 且干净报错、打开快照后截断的部分可读性、
空文件/单字节/块边界等尺寸边界、`ReadAt` 的 EOF 语义。
