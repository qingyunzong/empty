# Sitemap 分片与 lastmod 信任边界

搜索采集系统可导入的 Go sitemap 调度库。它负责展开 sitemap index、识别 gzip 子图、打断循环引用，并按主机与 URL 规范化结果去重；`lastmod` 只作为弱提示，页面是否产生新修订由内容指纹决定。

```go
package main

import (
	"context"
	"fmt"

	"example.org/dataeng/q0214"
)

func main() {
	fetcher := dataeng.NewHTTPFetcher(nil)
	store := dataeng.NewMemoryStore()

	scheduler := dataeng.NewScheduler(fetcher,
		dataeng.WithStateStore(store),
		dataeng.WithPublisher(dataeng.PublisherFunc(func(ctx context.Context, page dataeng.Page) error {
			fmt.Println(page.URL, page.Revision, page.Fingerprint)
			return nil
		})),
	)

	report, err := scheduler.Run(context.Background(), []string{
		"https://example.com/sitemap.xml",
	})
	if err != nil {
		// report 仍然包含成功分支发现的页面与每个子图的完成状态。
		fmt.Println(report.Watermark, err)
	}
}
```

## 关键语义

- `Scheduler.Expand` 返回 `Graph`：索引子图、gzip 子图、相对 `<loc>`、重复引用和循环引用都会被展开。循环边记录在 `SitemapNode.Cycles`，不会阻塞完成。
- URL 统一规范化为小写 scheme/host、去掉默认端口和 fragment、清理点段、保留查询参数；`Page.Host` 与 `Graph.PagesByHost()` 提供按主机分组。
- 内容的 SHA-256 指纹是修订依据。`lastmod` 只写入 `Page.LastMod` 和结果提示，指纹不变时即使 `lastmod` 变化也不会发布。
- 父图的 `Complete` 只有在全部非循环子图成功后才会置位；任一子图失败时父图保持 `NodeIncomplete`，`Watermark.RootsComplete` 不会推进。
- 发布成功后才写入确认状态。重复运行或失败重试时，已确认且指纹未变的页面会跳过；发布失败不会提前确认。

## 组件

- `ParseSitemap` / `ParseSitemapWithLimit`：解析 urlset、sitemapindex 与 gzip 流。
- `NormalizeURL` / `NormalizeURLWithBase` / `HostKey`：URL 与主机规范化。
- `ContentFingerprint` / `DecideRevision`：独立使用的内容指纹与修订判断。
- `Scheduler`：图展开、重试、指纹比较、幂等发布与完成水位。
- `RevisionTracker`：只使用状态存储与指纹判断时，可脱离调度器单独使用。

所有网络访问都通过 `Fetcher` 接口注入；测试或离线采集可使用 `MapFetcher`、`FetchFunc` 或自定义实现。
