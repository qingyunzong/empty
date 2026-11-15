// Package dataeng 实现大规模浏览器采集平台的 HAR 分片实时归档组件。
//
// 它把并发页面产生的请求、响应、重定向与正文 blob，按采集 run、target
// （页面）与 request id 归并成同一条记录，并针对采集侧的真实约束设计：
//
//   - 事件乱序、正文晚到：先把未闭合记录快照落到 runs/<run>/open，
//     后续事件持续归并；响应事件到达即闭合，open 快照随即清除。
//   - run 封闭后的迟到事件：CloseRun 固化基础世代（rev=0），之后到达的
//     每个事件派生一个不可变修订世代（gen-000001、gen-000002 ...），
//     并写入 revs/index.json，基础世代保持不变。
//   - blob 内容寻址去重：相同摘要的正文在 blobs/data 只存一份，但每个
//     来源 (run,target,request,role,event) 在 blobs/refs 保留独立引用。
//   - 崩溃恢复：所有事件先追加按 CRC32 校验的分段 WAL，再改内存态。
//     Open 重放 WAL 重建记录、open 快照与修订世代；事件 ID（显式给出或
//     按内容确定性派生）保证重放幂等。
//   - 恢复重放不重复发布：publish/ledger.json 记录已发布的世代单元，
//     PendingPublish/PublishStream 自动跳过账本中的键。
//
// 典型用法：
//
//	a, err := dataeng.Open("/var/lib/har-archive")
//	rec, err := a.Ingest(dataeng.Event{Type: dataeng.EvRequest, ...})
//	summary, err := a.CloseRun(runID)
//	items, err := a.PendingPublish(runID)
//	_ = a.MarkPublished(keys)
//	harBytes, err := a.ExportHAR(runID, dataeng.ExportOptions{})
package dataeng
