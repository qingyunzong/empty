# 压缩 NDJSON 分片消费组件

导出连接器要可导入的 Go 分片消费组件，每片有序号、压缩摘要、未压缩行数和全局 schema 版本。并行下载后按序流式解压，单行不得跨分片假设；重复片摘要一致可跳过，缺片阻止全局水位，但已验证片缓存可恢复复用。

本包提供：

- `Manifest` / `Shard`：分片元数据，全局 `schema_version`，按 `sequence` 排序与去重。
- `Consumer`：有界并发下载并按序交付记录，默认流式 gzip 解压。
- `Reader`：逐行 `Next()`，记录包含分片序号、片内行号和 schema 版本。
- `Watermark`：只在连续分片完整消费后推进；缺片/校验失败不会跳过。
- `DirCache`：按压缩摘要寻址的原子磁盘缓存，已验证片可跨重启复用。
- `Consumer.VerifyAll`：并行校验整份清单；缺片不阻止后续片入缓存，并报告被阻塞的水位。

## Manifest

```json
{
  "schema_version": "v1",
  "shards": [
    {
      "sequence": 0,
      "digest": "sha256:...",
      "line_count": 2,
      "schema_version": "v1"
    }
  ]
}
```

`digest` 是压缩载荷的 SHA-256，可写成 `sha256:<hex>` 或裸 hex。`line_count`
是解压后以换行结尾的行数（空行也计数）。清单可乱序，重复的
`sequence` 只有摘要、行数、schema 完全一致时才会去重，否则报冲突。

## 基本用法

```go
manifest, err := dataeng.ParseManifest(bytes.NewReader(manifestJSON))
if err != nil {
	return err
}

consumer := &dataeng.Consumer{
	Downloader:  connector,                 // 实现 Download(ctx, shard)
	Cache:       dataeng.NewDirCache(cacheDir),
	Concurrency: 4,
}
reader, err := consumer.Open(ctx, manifest)
if err != nil {
	return err
}
defer reader.Close()

for {
	rec, err := reader.Next()
	if err == io.EOF {
		break
	}
	if err != nil {
		return err
	}
	// rec.Sequence / rec.Line / rec.SchemaVersion / rec.Data
}
// Next 必须在读完一片后再调用一次以触发 EOF；此时该片才进入水位。
watermark := reader.Watermark()
```

`Downloader` 只需返回压缩字节流。`Decompress` 可替换解压器，默认
`GzipDecompressor`；返回值不得关闭底层 reader。

## 一致性与恢复语义

- 每个分片先校验压缩摘要，再解压校验行数和行边界，通过后才交付记录。
- 分片末尾没有换行视为 `ErrSplitLine`，不会把末行与下一片拼接。
- 摘要或行数不符分别返回 `ErrDigestMismatch` / `ErrLineCountMismatch`。
- 同一 `sequence` 的重复条目，摘要一致则去重；摘要不同则 `ErrShardConflict`。
- 下载失败或清单缺号返回 `MissingShardError`，`Reader.Watermark()` 停在该序号。
- `VerifyAll` 会继续校验缺片之后的分片并写入缓存；修复缺片后再次调用即可
  `watermark` 跨过缺口，已缓存片不会重复下载。
- `OpenAt(ctx, manifest, watermark)` 可从持久化水位续读，之前的片不会重新交付。
- 缓存条目每次使用前仍会重新校验摘要、行数和行边界；缓存损坏会回退到下载。
  缓存读写失败通过 `OnCacheError` 报告，不阻断数据正确性。

`Reader.Next` 不是并发安全的；一个 `Reader` 应由单个消费者 goroutine 使用。
`Consumer` 配置完成后可安全地同时创建多个 reader。未读完就 `Close` 不会推进
当前不完整分片的水位。
