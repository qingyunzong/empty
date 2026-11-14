# 对象存储 manifest 发布

湖区写入器要可直接接入 Go manifest 发布库，在对象只支持 put/get/list 的条件下，以不可变数据文件、版本 manifest 和单一指针实现原子可见批次。读者验证摘要与父版本；并发发布用条件写裁决，失败者重基但不覆盖胜者。

本包实现了上述协议。批次只在 `metadata/HEAD` 指针切换成功后对读者可见；
数据对象和 manifest 都不会被原地修改。

## 对象布局

相对于表前缀（例如 `warehouse/events`）：

```text
data/sha256/<sha256-hex>                 不可变数据对象（内容寻址）
metadata/manifests/<sha256-hex>.json     不可变版本 manifest
metadata/HEAD                            唯一可变指针
```

manifest 的身份就是其 JSON 字节的 sha256 摘要。manifest 只描述本批次新增的
文件、代次 `generation` 和父 manifest 摘要 `parent`。指针同时记录
`manifest`、`previous` 与 `generation`，因此读者可以交叉验证摘要和父版本。

## 快速接入

```go
store := dataeng.NewMemoryStore() // 生产环境可适配任意 put/get/list 客户端

writer := dataeng.NewWriter(store, "warehouse/events")
version, err := writer.WriteBatch(ctx, []dataeng.Input{
    {Path: "2026/11/part-0001.parquet", Data: part1},
    {Path: "2026/11/part-0002.parquet", Data: part2},
})
if err != nil {
    return err
}

reader := dataeng.NewReader(store, "warehouse/events")
snapshot, err := reader.Open(ctx) // 校验 HEAD、manifest 摘要和完整父链
if err != nil {
    return err
}
for _, file := range snapshot.Files {
    data, err := reader.ReadFile(ctx, file) // 每次读取都校验数据摘要与长度
    if err != nil {
        return err
    }
    _ = data
}
_ = version
```

外部 manifest 生产者可以先自行上传数据对象，再把描述符交给
`Writer.PublishFiles`；`File.Object` 省略时会按摘要推导为
`data/sha256/<hex>`。也可以直接使用 `Publisher` 的
`Current`/`PutManifest`/`UpdateHead` 三步协议。

## 并发发布

`ConditionalStore` 在 `Store` 之上增加原子的
`PutIfMatch(ctx, key, data, expectedToken)`。`expectedToken == ""` 表示
HEAD 必须不存在；否则它是当前 HEAD 字节的摘要。`MemoryStore` 已实现该接口。

提交循环如下：

1. 读取 HEAD，验证当前 manifest 摘要、代次与父版本；
2. 以当前 HEAD 为父、代次加一，写不可变 manifest；
3. 条件写 HEAD；
4. 冲突时重新读取胜者的 HEAD，用同一批不可变数据重建立 manifest 后重试。

失败者只追加自己的版本，不会把基于旧父版本的指针覆盖到胜者之上。超过
`WithMaxAttempts` 后返回包裹 `ErrConflict` 的错误，已暂存批次仍保留，可再次
`Commit`。

对象服务若只暴露无条件 put/get/list，本包在单进程内用按键锁串行化
check-and-put；跨进程的严格线性化仍要求服务端提供 If-Match/If-None-Match
语义的条件写（即实现 `ConditionalStore`）。

## 读者保证

- `Reader.Open` 校验 HEAD 中 manifest 摘要、manifest 自身摘要、代次和完整父链。
- `Reader.OpenAt(id)` 固定读取一个历史 manifest，HEAD 后续移动不影响该快照。
- `Reader.ReadFile` 校验数据对象摘要和长度；`Reader.Verify` 校验全部可见数据。
- 同一快照中的所有文件来自同一个已提交 manifest，不会看到半个批次。
