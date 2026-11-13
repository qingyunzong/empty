# S3 列举与版本删除归并

对象湖采集器需要可直接接入的 Go S3 inventory 状态库，合并 ListObjectVersions 的 version、delete marker、分页 key marker 与并发上传。每页结果写入暂存世代，完整遍历后才发布快照；重复页幂等，marker 不前进时停止。最新版视图与历史版本视图分别可查询。
