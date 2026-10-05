# scompact — 崩溃安全的存储整理 CLI

活页搬入紧凑段，外部引用经稳定页 ID 解析；搬迁与引用更新作为同一代
（generation）原子发布。掉电时旧引用或新引用必居其一且完整。

## 设计

- **段文件** `seg-*.seg`：追加式记录 `[magic|pageID|len|crc32|payload]`，
  每页带 CRC32 摘要。
- **索引** `index-<gen>.idx`：`pageID → (segment, offset, len)`，整文件
  CRC，经 tmp + fsync + rename 原子发布。
- **清单** `manifest.json`：代际号 + 存活段集合。清单的 rename 是唯一
  提交点：之前旧代完整，之后新代（段与索引均已 fsync）完整。
- **整理**：复制活页（逐页核对摘要）→ fsync 新段 → 同代发布新索引与
  清单 → 退役旧段（退役前核对无存活引用落入回收范围）。崩溃遗留的孤儿
  段/索引/tmp 文件在下次 `Open` 时回收。
- **故障注入**：`store.Hooks` 在复制、索引刷盘、退役边界提供钩子，测试
  用其模拟掉电并验证恢复不变量。

## 使用

```sh
go build ./cmd/scompact
scompact -dir <path> put <id> <payload>
scompact -dir <path> get <id>
scompact -dir <path> delete <id>
scompact -dir <path> list
scompact -dir <path> compact
scompact -dir <path> verify
```

## 测试

```sh
go test ./...
```
