# Sitemap 分片与 lastmod 信任边界

搜索采集系统要嵌入可导入的 Go sitemap 调度库，展开 sitemap index、gzip 子图和循环引用，按主机规范化 URL。lastmod 只作为弱提示，内容指纹决定修订；子图失败不能推进父图完成水位，重试不会重复发布已确认页面。
