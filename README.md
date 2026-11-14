# RSS/Atom 条目身份合并

`dataeng` 是一个可导入的 Go feed 归并库，供订阅采集器把多次抓取到的
Atom/RSS 条目归并为稳定的「身份链（chain）」。库本身不绑定具体 XML
解析器：解析层把 Atom、RSS 统一映射为 `Entry`，归并层负责判定身份、
保留版本、记录冲突与证据。

## 身份如何确定

条目身份由以下信号联合确定，按强到弱的优先级：

1. **Atom id**（`Entry.AtomID`，如 `tag:` URI）——最强身份。
2. **RSS guid 的 permalink 标志**
   - `isPermalink="true"`：guid 视为永久 URL，经规范化后按链接匹配；
   - `isPermalink="false"` 或缺省：guid 视为不透明 token，绝不按 URL 解析。
3. **规范链接**：显式 `rel="canonical"` 优先，其次 Atom `alternate`，
   再次普通链接，最后回退 RSS `<link>`。链接会先相对 feed URL 解析为
   绝对地址，再去除 `utm_*`、`gclid` 等跟踪参数、排序 query。
4. **域名迁移桥接**：对规范化 URL 忽略 scheme/host，仅保留 path+query，
   且要求内容摘要一致才合并——迁移域名的老文章保留原链，而碰巧同 path
   的无关文章不会被误并。
5. **内容摘要**：对归一化空白后的 `Summary + Content` 取 SHA-256，仅在
   条目没有任何强身份（如无 guid 的 RSS item）时作为兜底身份。

## 版本链与不静默覆盖

- 同一身份的每次观测都成为链上的一个 `Version`，按摄入顺序排列，原始
  字段完整保留，改标题、改正文、迁移域名都会在 `Changes`/`ChangeHistory`
  中标注。
- **相同 guid（或 Atom id、permalink）但正文不同**不会覆盖：两个正文都
  保留为独立版本，并在 `Chain.ContentConflicts` 中显式记录冲突及各自的
  摘要指纹，保证差异可审计。
- 完全相同的重复投递标记 `Version.Duplicate`，不产生冲突。

## 日期裁决

- 支持 RFC1123/RFC822（RSS）、RFC3339（Atom）及常见遗留布局，可通过
  `MergerOptions.DateFormats` 覆盖。
- 裁决时间优先取 `Updated`，其次 `Published`。
- **日期解析失败不参与新旧裁决**：失败字段进入 `Version.DateIssues`，
  保留原始字符串与失败原因；此时 `AdjudicatedTime` 为 `nil`，
  `Chain.Latest` 为 `nil`、`RankedVersions` 不含该版本，绝不用零值时间
  冒充可比较时间。只要链上存在可解析日期，仍由这些版本正常排序。

## 原始字段证据

每个版本的 `Version.Evidence` 保留：原始 Atom id、guid 原文与 permalink
标志、规范化前后的链接、全部原始链接、遗留 RSS `<link>`、标题、日期、
摘要、正文以及计算出的内容摘要指纹。`Version.Matches` 与 `Chain.Matches`
记录每一条合并决策使用的信号类型、原始值、规范化键和被连接的两个版本
序号，输出可完整回溯。

## 用法

```go
chains := dataeng.Merge(entries, nil) // entries 为 []dataeng.Entry
for _, chain := range chains {
    latest := chain.Latest // 无可用日期时为 nil
    for _, conflict := range chain.ContentConflicts {
        // 同身份不同正文，不会静默覆盖
        _ = conflict
    }
}
```

增量摄入可使用 `NewMerger`：

```go
merger := dataeng.NewMerger(&dataeng.MergerOptions{
    StripQueryParams: []string{"utm_source"},
})
merger.Add(entry)
chains := merger.Chains()
```

## 测试

`go test ./...` 覆盖：同 Atom id 改标题保留版本链、同 guid 不同正文冲突、
permalink guid 与规范链接归一合并、不透明 guid 不按 URL 处理、域名迁移
（同正文合并/异正文分离）、无 guid 摘要兜底、重复投递、坏日期不参与裁决、
updated 优先于 published、相对链接解析、三信号传递合并与证据保留等场景。
