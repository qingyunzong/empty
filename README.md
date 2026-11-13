# Common Crawl 索引范围读取

离线网页采集器需要可导入的 Go CDX/WARC 范围读取协调器，按 filename、offset、length、digest 和 status 生成请求并校验返回范围。CDX 重复项按 crawl/time 世代保留；Range 被忽略或字节摘要不符时拒绝，不把相邻 WARC 记录误认目标。
