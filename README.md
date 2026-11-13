# Server-Sent Events 游标恢复

采集网关需要可导入的 Go SSE 流解析器，处理 UTF-8 跨块、CR/LF、data 多行、id 空值与 retry。只有完整空行结束事件，Last-Event-ID 在输出确认后提交；连接中断时半事件丢弃。重复 id 不自动去重，由调用方策略决定并保留原到达序。

## 使用

```go
parser := dataeng.NewParser(resp.Body)

for {
	event, err := parser.Next()
	if err != nil {
		break
	}

	if err := output.Write(event); err != nil {
		break
	}

	// 只有输出成功后才推进可恢复游标。
	if err := parser.Commit(event); err != nil {
		break
	}
}

resumeFrom := parser.LastEventID()
```

分块推送场景可直接使用 `Feed`：

```go
parser := dataeng.NewParser()
for chunk := range chunks {
	for _, event := range parser.Feed(chunk) {
		if err := output.Write(event); err != nil {
			return err
		}
		if err := parser.Commit(event); err != nil {
			return err
		}
	}
}
```

`Feed` 会保留未完成的行和事件。连接中断时停止喂入即可，半事件不会被返回；也可以调用 `Close` 显式结束并丢弃半事件。

## 行为约定

- 按字节增量解析，UTF-8 多字节字符可跨任意 `Read`/`Feed` 边界。
- 接受 `CRLF`、`LF`、`CR` 三种行结束符，`CRLF` 跨块时按一个结束符处理。
- 事件仅在完整空行后产出；`data` 多行以 `\n` 连接，字段值仅移除冒号后的一个前导空格。
- `id:` 空值会清空后续事件的 ID；含 NUL 的 id 按规范忽略。
- 仅由 ASCII 数字组成的 `retry` 生效，单位毫秒；非法值保持原重连时间。
- `LastEventID()` 只返回已通过 `Commit`/`Ack`/`Confirm` 确认的游标；解析或读取到的未确认 ID 可通过 `PendingEventID()` 查看。
- 重复 id 不去重，所有完整事件按到达顺序产出，`Event.Sequence` 从 1 递增。
