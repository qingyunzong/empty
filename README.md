# 容器日志 partial 标志归并

节点日志入口需要可导入的 Go CRI partial 记录重组库，按 stream、tag、时间和文件世代拼接 P/F 片段。轮转后旧 partial 不接到新文件，同时间的输出流与错误流独立；片段超限或缺终片时输出带截断标记的一条记录，不能静默丢弃。

## 使用

```go
import dataeng "example.org/dataeng/q0094"

r := dataeng.NewReassembler(
	dataeng.WithMaxBytes(64*1024),
	dataeng.WithMaxFragments(64),
)

for _, line := range lines {
	for _, rec := range r.AddLine(line) {
		// rec.Content 是拼接后的完整日志；rec.Truncated 表示是否为截断记录。
		emit(rec)
	}
}

// 文件结束或轮转：未等到 F 的 partial 会作为一条带截断标记的记录输出。
for _, rec := range r.Rotate() {
	emit(rec)
}
```

也可以直接传结构体。`Timestamp` 和 `Generation` 接受 `time.Time`、RFC3339 字符串或整数；轮转时也可以显式指定新世代：

```go
r := dataeng.New()
r.Add(dataeng.Record{
	Timestamp:  t,
	Stream:     dataeng.Stdout,
	Tag:        dataeng.P,
	Content:    "part one",
	Generation: "file-0001",
})
out := r.Rotate("file-0002") // 旧 partial 先以 Truncated 输出
r.Add(dataeng.Record{
	Timestamp:  t,
	Stream:     dataeng.Stdout,
	Tag:        dataeng.F,
	Content:    "part two",
	Generation: "file-0002",
})
_ = out
```

批量入口 `Reassemble` / `ReassembleLines` 会在结束时自动 flush。`Truncated` 记录的内容默认追加
`[truncated]`，可通过 `WithTruncationMarker` 修改。

## 边界规则

- P/F 片段必须同时匹配 stream、来源 tag、时间和文件世代；同一时间戳下 stdout 与 stderr 不会互相拼接。
- 文件世代变化或调用 `Rotate` 时，旧世代未完成的 partial 先输出为截断记录，再开始接收新文件。
- 超过字节数或片段数限制时，立即输出一条截断记录；同一序列剩余片段不会再产生第二条记录。
- `Flush`/`Close` 时仍缺少 F 的 partial 输出为截断记录，绝不静默丢弃。
