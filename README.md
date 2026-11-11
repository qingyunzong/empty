# q194

用于文献采集流的 Go 流式 XML 记录抽取组件。

## 用法

```go
cfg := q194.Config{
	Record: q194.Name{Space: "urn:records", Local: "item"},
	Attributes: []q194.Name{
		{Space: "urn:records", Local: "id"},
		{Local: "source"},
	},
	ChildText: []q194.Name{
		{Space: "urn:records", Local: "title"},
	},
}

err := q194.Consume(input, cfg, func(event q194.Event) error {
	switch event.Kind {
	case q194.EventStart:
		// event.Attributes contains the configured attributes present on the tag
	case q194.EventField:
		// event.Field, event.Value, event.Source
	case q194.EventCommit:
		// record is complete and may be published
	case q194.EventAbort:
		// discard everything collected for event.Record
	}
	return nil
})
```

`q194.NewReader` exposes the same stream through `Next`. `q194.ConsumeContext`
adds cancellation; cancelling while a record is open delivers an `EventAbort`
before returning `context.Canceled`. Returning an error from the handler while
a record is open also produces an `EventAbort` before consumption stops.

## 行为

- 配置使用展开名（命名空间 URI + 本地名），不是前缀。
- 命名空间前缀在其元素作用域内解析，支持重绑定；默认命名空间只作用于元素，不作用于无前缀属性。
- 只收集记录标签上配置的属性，以及记录的直接子元素中直接出现的字符数据。孙元素文本不会并入字段；同名子元素嵌套也不会重启记录。
- 输入按块流式解析，实体和字符引用可跨块。仅接受 `lt`、`gt`、`amp`、`apos`、`quot` 和合法数字字符引用。
- 拒绝 DTD 及其他 XML directive。
- 每条记录按 `Start -> Field* -> Commit` 交付。开始后遇到语法、输入、非法字符或闭合错误时交付 `Abort`，该记录不得提交。

## 测试

```sh
go test ./...
```

测试通过每次只返回一个字节的 reader 覆盖跨块实体、前缀重绑定、同名嵌套、
非法码点、晚到闭合错误和半条记录取消。
