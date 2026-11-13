# S3 版本清单状态库

`dataeng` 是一个可直接嵌入对象湖采集器的内存状态库，用来接收 S3
`ListObjectVersions` 的分页结果，并把 version、delete marker、分页游标和遍历期间
发生的并发上传合并成一致的快照。

## 语义

- 每个 `Generation` 是独立的暂存世代。写入页时只修改暂存状态，读者始终看到上一份
  已发布 `Snapshot`。
- 记录以 `(key, versionID)` 为身份合并，重试页和相邻页重叠不会产生重复记录。
- 只有看到 `IsTruncated == false` 的最后一页，`Publish` 才会成功。未完整遍历或
  marker 停滞的世代可以 `Abort`，不会污染已发布快照。
- 截断页的 `NextKeyMarker/NextVersionIDMarker` 必须严格前进（先比较 key，key 相同时
  比较 version ID）。不前进或为空时 `ApplyPage` 返回 `ErrMarkerNotAdvanced`，
  `Collect` 会停止并放弃该世代。
- `RecordUpload` / `RecordDeleteMarker` 记录遍历期间的上传。它们在当前快照中不可
  见，而是在下一次发布时合并；发布后发生的上传会立即更新发布快照。
- 最新版视图每个 key 最多一条记录，最新条目是 delete marker 的 key 不出现在视图。
  历史版本视图包含全部 version 和 delete marker，按 key 升序、同 key 内从新到旧。

## 直接接入

```go
store := dataeng.NewStore()

snapshot, err := store.Collect(ctx, func(ctx context.Context, after dataeng.Marker) (dataeng.Page, error) {
	// 把 after 转换为 ListObjectVersions 的 KeyMarker / VersionIdMarker。
	out, err := s3.ListObjectVersions(ctx, &s3.ListObjectVersionsInput{
		Bucket:          &bucket,
		KeyMarker:       strOrNil(after.KeyMarker),
		VersionIdMarker: strOrNil(after.VersionIDMarker),
	})
	if err != nil {
		return dataeng.Page{}, err
	}
	return dataeng.Page{
		Versions:            convertVersions(out.Versions),
		DeleteMarkers:       convertDeleteMarkers(out.DeleteMarkers),
		IsTruncated:         aws.ToBool(out.IsTruncated),
		NextKeyMarker:       aws.ToString(out.NextKeyMarker),
		NextVersionIDMarker: aws.ToString(out.NextVersionIdMarker),
	}, nil
})
if err != nil {
	return err
}

latest := snapshot.LatestView()      // []dataeng.Record
history := snapshot.HistoryView()    // []dataeng.Record, 含 delete marker
rec, ok := snapshot.Latest("images/a.jpg")
versions, ok := snapshot.History("images/a.jpg")
```

需要自己驱动分页时，可以直接使用 `Begin`/`ApplyPage`/`Publish`：

```go
gen := store.Begin()
for {
	page := fetch(marker)
	result, err := gen.ApplyPage(page)
	if errors.Is(err, dataeng.ErrMarkerNotAdvanced) {
		gen.Abort()
		return err
	}
	if err != nil {
		gen.Abort()
		return err
	}
	if result.Complete {
		return gen.Publish()
	}
	marker = result.Marker
}
```

`ObjectVersion.VersionId`、`DeleteMarker.VersionId` 和
`Page.NextVersionIdMarker` 是 AWS SDK 拼写的兼容别名；两种拼写同时出现时必须一致。
