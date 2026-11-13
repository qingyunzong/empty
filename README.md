# Common Crawl 索引范围读取

离线网页采集器需要可导入的 Go CDX/WARC 范围读取协调器，按 filename、offset、length、digest 和 status 生成请求并校验返回范围。CDX 重复项按 crawl/time 世代保留；Range 被忽略或字节摘要不符时拒绝，不把相邻 WARC 记录误认目标。

## 用法

```go
recs, _ := dataeng.ParseCDX(r)          // 解析 CDX 索引
recs = dataeng.Deduplicate(recs)        // 同 digest 保留最新 crawl/time 世代

f := &dataeng.Fetcher{BaseURL: "https://data.commoncrawl.org/"}
for _, rec := range recs {
    if !rec.Fetchable() {               // 仅 2xx status
        continue
    }
    res, err := f.Fetch(ctx, rec)       // Range 请求 + 五重校验
    _ = res.Body                        // 恰好 length 字节的 WARC 记录段
}
```

校验顺序：必须 `206 Partial Content`（`200` 视为 Range 被忽略而拒绝）→
`Content-Range` 前缀匹配 → 字节数恰好等于 `length` → 范围字节 SHA-1
（base32 无填充）与 CDX `digest` 一致 → 解压后 `WARC-Target-URI` 与目标
URL 一致（防止相邻 WARC 记录误认）。
