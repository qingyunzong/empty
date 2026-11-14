# 邮件附件关系去重

邮件数据入口要可直接接入 Go 附件实体归并组件，联合 MIME Content-ID、文件名、内容摘要、内嵌引用与转发层级建立关系。相同内容在不同邮件中可共享 blob 但附件实体独立；cid 只在对应 multipart/related 作用域解析，嵌套邮件不串联。

## 结构

- `maildata`：邮件数据入口。`Parse(raw)` 把 RFC822 邮件解析为扁平的 `Entry` 列表（嵌套的 message/rfc822 转发邮件 Depth 递增），附件部件归一化为 `Attachment`（含 Content-ID、文件名、sha256 摘要、related 作用域、同作用域 HTML 的 cid 引用）。
- `merge`：附件实体归并组件。`Merger.AddEntry` 直接消费 `Entry`，按内容摘要共享 `Blob`、每次出现生成独立 `Entity`，并建立 `same-content` / `forward-chain` / `same-name` / `same-cid` / `inline-ref` 关系。

## 用法

```go
entries, err := maildata.Parse(rawMail)
m := merge.NewMerger()
for _, e := range entries {
    m.AddEntry(e)
}
for _, ent := range m.Entities() {
    // ent.Relations 为与其他实体的关系
}
```

运行测试：`go test ./...`
