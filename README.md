# WARC revisit 载荷解析

网页档案服务需要可导入的 Go WARC 记录关系库，把 response、request、revisit、conversion 与 continuation 通过 record id 和 refers-to 连接。revisit payload digest 只能引用已验证原记录，循环或跨集合缺失明确失败；分段记录按 segment number/total length 无缝重组。

## 用法

```go
g := warc.NewGraph()
g.Add(&warc.Record{Type: warc.TypeResponse, ID: "<orig>",
    PayloadDigest: "sha1:…", Content: payload})
g.Add(&warc.Record{Type: warc.TypeRevisit, ID: "<rev>",
    RefersTo: "<orig>", PayloadDigest: "sha1:…"})

if err := g.Resolve(); err != nil {
    // errors.Is 匹配 ErrMissingReference / ErrReferenceCycle /
    // ErrPayloadDigestMismatch / ErrSegmentGap 等哨兵错误
}

target, _ := g.RefersTo("<rev>")     // refers-to 目标
refs := g.Referrers("<orig>")        // 反向引用
body, _ := g.Reassembled("<seg1>")   // 分段重组内容
```

校验规则：

- revisit 的 `RefersTo` 必须指向本集合内带可验证 payload digest 的原记录（response/resource/conversion 等），指向另一条 revisit 或 digest 不一致都会失败；
- `RefersTo` / `ConcurrentTo` 指向集合外记录、refers-to 成环均明确报错；
- 分段记录要求 segment number 从 1 连续、末段声明 total length 且与重组长度一致。
