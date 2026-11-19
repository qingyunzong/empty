# DNS 查询路由库

`formal` 包实现一个确定性的 DNS 存根解析器路由引擎。它不直接做网络 I/O，而是把上游交互抽象为 `Transport`，把时间抽象为虚拟时钟 `Clock`，因此同一输入总会得到同一份完整轨迹。

## 快速开始

```go
cfg := formal.Config{
	StubDomains: map[string][]formal.Forwarder{
		"corp.example.com": {
			{Address: "10.0.0.53"},
		},
	},
	DefaultForwarders: []formal.Forwarder{
		{Address: "192.0.2.53"},
		{Address: "192.0.2.54"},
	},
	SearchDomains: []string{"corp.example.com", "example.com"},
	Ndots:         2,
	Timeout:       2 * time.Second,
}

tr := formal.TransportFunc(func(name, forwarder string) formal.Reply {
	if name == "api.corp.example.com." {
		return formal.Reply{Latency: 3 * time.Millisecond}
	}
	return formal.Reply{
		Rcode:   formal.RcodeNameError,
		Latency: 2 * time.Millisecond,
	}
})

result, err := formal.Resolve(formal.Query{
	Name:      "api.corp",
	Config:    cfg,
	Cache:     formal.MapCache{"api.corp.example.com.": {Values: []string{"10.1.2.3"}}},
	Clock:     formal.NewVirtualClock(time.Unix(0, 0)),
	Transport: tr,
})
```

## 路由语义

- **完整名优先规则**：输入以 `.` 结尾时视为绝对名，只查询该名，不再应用搜索域。相对名统计其中的点号数：点数 `>= Ndots` 时先查绝对名，再按 `SearchDomains` 顺序逐个补后缀；点数 `< Ndots` 时先补后缀，最后查绝对名。
- **存根域**：每次生成的完整查询名独立匹配 `StubDomains`。匹配要求标签边界相等，并按最长后缀优先。归一化后重复的存根域（例如大小写或末尾点号造成的并列）属于非法配置，返回明确错误。
- **转发器**：匹配到存根域时只使用该存根域的转发器列表，不会在全部失败后回退到默认转发器。默认转发器只用于未匹配存根域的名字。列表严格按顺序尝试。
- **超时**：每次尝试使用 `Forwarder.Timeout`；为零时使用 `Config.Timeout`（再为零则使用 `DefaultAttemptTimeout`）。`Latency == Timeout` 视为按时到达，`Latency > Timeout` 才记为超时并回退到下一个转发器。超时只消耗 `Timeout` 的虚拟时间。
- **响应分类**：`NOERROR` 立即结束解析；`NXDOMAIN` 是该名字的确定否定答案，停止对该名字尝试其余转发器并继续下一个搜索候选；传输错误和其他响应码会回退到下一个转发器。
- **缓存**：每个候选名在转发前先查缓存。正缓存命中立即结束解析；负缓存命中不会触发该名字的转发，但会继续后续候选。缓存命中本身不消耗虚拟时间。
- **虚拟时钟**：`Resolve` 按每次尝试实际等待的时间推进 `Clock`，`Result.Elapsed` 与时钟推进量一致。

## 输出轨迹

`Result` 同时给出三类信息：

- `Queries`：完整候选名序列，以及每个候选是否命中缓存。
- `Attempts`：每次真正发往转发器的交换，包括查询名、转发器、匹配的存根域、结果分类、延迟和实际等待时间。
- `Source`：最终来源。成功时是 `cache`、`stub` 或 `default`；没有肯定答案时是 `none`，`Reason` 说明 `nxdomain`、`timeout` 或 `failure`。

所有查询名在输出中均为小写并带末尾根点；输入名保持原样记录在 `Result.RequestedName`。

## 非法配置

`Resolve` 和 `Config.Validate` 对非法配置返回包裹 `ErrInvalidConfig` 的 `*ConfigError`，其中包含字段名和原因。当前会拒绝：

- 负数 `Ndots`、负数超时；
- 空默认转发器列表、空地址、地址两端空白、同一列表内重复地址；
- 空/非法搜索域、归一化后重复的搜索域；
- 空/非法存根域、空转发器列表、归一化后重复的存根域（最长后缀并列）。

非法查询名返回 `ErrInvalidName`；需要转发但没有提供 `Transport` 时返回 `ErrNoTransport`。

## 差分测试

`internal/oracle` 是按规范独立重写的参考实现，不复用被测包的名称归一化、候选排序、存根匹配、超时或缓存策略。测试逐场景比较完整轨迹，并额外包含手写黄金期望：

- `TestNDotsAdjacentValuesExhaustive` 穷举每个点号数周围的 `Ndots-1/Ndots/Ndots+1` 及边界值；
- `TestCanonicalDuplicateStubDomainsAreTiesAndRejected` 覆盖最长后缀归一化并列；
- `TestSearchDomainCompletionHitsAtEveryPosition` 覆盖每个搜索候选位置的缓存命中；
- `TestTimeoutFallbackBoundaries` 覆盖 `Timeout-1ns/Timeout/Timeout+1ns`、每转发器覆盖值和全部超时；
- `TestRandomizedDifferential` 用固定种子生成 400 组组合场景做差分。

黄金期望由规范手写，参考期望由独立 oracle 计算，均不由被测包生成。

运行：

```sh
go test ./...
go vet ./...
```
