# TAR 稀疏文件区间重建

归档导入器要可直接接入 Go tar 稀疏映射解析库，支持 PAX GNU.sparse 版本与旧 header 表示。数据 extent 必须有序、不重叠且落在 logical size 内；空洞按零读取但不实际分配。header size 与稀疏数据消费精确匹配，后续 entry 边界不偏移。

## 用法

`dataeng.Reader` 是流式的 `archive/tar` 兼容导入器。`tar.Header.Size` 是展开后的
logical size，`Entry.Sparse` 保留原始数据 extent；`Entry.PhysicalSize` 是归档中该
entry body 的精确字节数（PAX 1.0 含 in-body 稀疏 map）。

```go
importer := dataeng.NewReader(archive)
for {
    entry, err := importer.Next()
    if err == io.EOF {
        break
    }
    if err != nil {
        return err
    }

    // 读取展开后的逻辑内容；空洞按零返回。
    if _, err := io.Copy(destination, entry); err != nil {
        return err
    }
}
```

若目标实现 `io.WriteSeeker`，`io.Copy` 会走 `SparseReader.WriteTo`，用 `Seek`
跳过空洞；只有文件以空洞结尾时才写一个零字节来设置正确长度。也可以直接使用
`dataeng.Expand` / `dataeng.NewSparseReader`。

支持的稀疏编码：

- PAX `GNU.sparse.offset` / `GNU.sparse.numbytes`（0.0）
- PAX `GNU.sparse.map` / `GNU.sparse.numblocks`（0.1）
- PAX `GNU.sparse.major=1` / `GNU.sparse.minor=0`，map 位于 entry body 首部（1.0）
- 旧 GNU type `S` header 及 512 字节 sparse extension blocks

解析后统一使用 decimal 的 `Extent{Offset, Length}`。零长度 extent（常见于 GNU
文件的末尾）会被保留，但在读取时不会消费数据。
