# robots 规则世代与抓取租约

面向多租户爬虫的可导入 Go 组件。按 `scheme/host/port` 缓存解析后的
user-agent 规则、`Crawl-delay` 与过期世代；任务领取时绑定策略版本；新策略
只能取消尚未发出的请求，已完成证据保持不可变；网络失败按配置执行
fail-open / fail-closed 并写入审计。

模块路径：`example.org/dataeng/q0216`。实现位于
`example.org/dataeng/q0216/robots`，根包 `dataeng` 重新导出同一组类型与
构造器，两种导入方式均可。

## 快速开始

```go
package main

import (
	"context"
	"fmt"
	"time"

	"example.org/dataeng/q0216/robots"
)

func main() {
	audit := robots.NewAuditLog(4096)
	manager, err := robots.NewManager(robots.Config{
		UserAgent:   "tenant-crawler/1.0",
		TTL:         24 * time.Hour,
		FailureTTL:  5 * time.Minute,
		FailureMode: robots.FailClosed,
		Auditor:     audit,
	})
	if err != nil {
		panic(err)
	}
	defer manager.Close()

	ctx := context.Background()
	lease, err := manager.Claim(ctx, robots.Task{
		Tenant: "tenant-a",
		URL:    "https://example.com/article/42",
	})
	if err != nil {
		panic(err)
	}
	defer lease.Release()

	permit, err := lease.Begin(ctx, "/article/42")
	if err != nil {
		// ErrDisallowed / ErrClaimRevoked 等。
		panic(err)
	}
	defer permit.Close()

	// 网络请求真正发出前调用。若此时策略已更新，MarkSent 返回
	// ErrPolicySuperseded，调用方必须放弃发送。
	if err := permit.MarkSent(); err != nil {
		panic(err)
	}

	// 使用 permit.Context() 发起请求。已发送的请求不会被后续策略取消。
	// _, err = http.NewRequestWithContext(permit.Context(), ...)

	completed, err := permit.Complete(robots.Evidence{
		ID:         "tenant-a:example.com:42",
		StatusCode: 200,
		Body:       []byte("..."),
	})
	if err != nil {
		panic(err)
	}
	fmt.Printf("evidence %s bound to policy v%d/g%d\n",
		completed.ID, completed.PolicyVersion, completed.PolicyGeneration)
}
```

## 语义保证

- **缓存键**：`Scope{Tenant, Origin}`，其中 `Origin` 规范化
  `scheme/host/port`，省略端口时补 `80/443`，host 小写并去除尾部点。
  不同租户、不同源之间完全隔离。
- **策略版本**：每次安装策略都会得到全局唯一、单调递增的 `Version`；
  同一源的安装次数另记为 `Generation`。`Claim.Version()` 是任务领取时
  绑定的版本。条件写入使用安装前观察到的最后版本做 CAS，慢请求不能在
  新世代之后回填旧规则；缓存淘汰也不会重置世代。
- **TTL**：`Cache.Get` 只返回未过期快照，`Cache.Lookup` 可读取过期快照供
  诊断。`Manager.Resolve` 在过期后同步刷新；并发任务共享同一个
  single-flight 抓取。
- **租约失效**：同一租户/源发布新策略后，旧 `Claim` 立即失效，所有尚未
  `MarkSent` 的 `Permit` 被 `context.Cancel`，原因可通过
  `context.Cause(permit.Context())` 读取，通常为
  `ErrPolicySuperseded`。
- **已发送请求**：`MarkSent` 成功后，策略更新不会取消该请求。它仍可用旧
  `Version` 追加证据。
- **证据不可改写**：`EvidenceStore` 仅有 `Append` / `Get`，没有更新或删除。
  内存实现按 ID 去重并返回深拷贝；重复 ID 返回 `ErrEvidenceExists`，因此
  新规则无法覆盖已完成证据。
- **抓取延迟**：解析 `Crawl-delay`（支持小数秒）并随快照缓存，可通过
  `lease.CrawlDelay()` 或 `snapshot.CrawlDelay(userAgent)` 读取。

## 失败与审计

`FailureMode` 零值为 `FailClosed`（安全默认）：

| 结果 | 行为 | `Source` |
| --- | --- | --- |
| 2xx 且解析成功 | 安装文档规则 | `SourceFetched` |
| 404 / 410 / 其他 4xx | 无限制（RFC 9309） | `SourceAbsent` |
| 401 / 403 | 全部禁止 | `SourceAccessDenied` |
| 429 / 5xx / 超时 / 重定向越界 / 响应过大 / 解析失败 | 按 `FailureMode` 生成回退策略 | `SourceFallback` |
| `InstallPolicy` / `Publish` | 直接发布规则，不经过网络 | `SourceOperator` |

回退快照带 `Degraded=true`、`FailureMode` 和 `Problem`，并使用
`FailureTTL` 缓存。`Resolve` 仍返回可用快照，租约可正常领取；是否继续
抓取由回退策略决定。所有关键转换写入 `Auditor`，包括抓取失败、回退、
策略安装、过期世代丢弃、租约失效、未发送请求取消、请求拒绝以及证据
写入/拒绝。`AuditLog` 是可直接使用的有界内存实现。

## 关键 API

- `Parse` / `ParseBytes` / `Rules.Evaluate`：RFC 9309 风格解析与匹配，
  支持最具体 user-agent 组、`*` 通配、`$` 锚点、最长匹配、同长度
  `Allow` 优先与空 `Disallow`。
- `Cache`：租户/源维度的 LRU、TTL、世代和版本 CAS。
- `Manager`：抓取、single-flight、回退、审计、租约注册与撤销。
- `Claim`（别名 `Lease`）：绑定快照、评估目标、创建 `Permit`。
- `Permit`：`MarkSent` 划分“未发送/已发送”边界，`Complete` 追加证据。
- `Evidence` / `EvidenceStore` / `MemoryEvidenceStore`：append-only 完成证据。

## 测试

```sh
go test ./...
go test -race ./...
go vet ./...
```
