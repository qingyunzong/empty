# 关闭后的改正与侧输出

采集流水线调用可导入的Go包处置迟到事件，不推进外部水印。窗口在水印到达结束时间时关闭。关闭之后、结束时间加允许迟到之前的事件可以改正结果，并给出对应撤回。超过允许迟到的事件只进侧输出。允许迟到为0时，关闭后的事件全部侧输出。用时钟核对改正窗口、侧输出和零迟到，期望不得由被测包生成。

## 实现

包 `dataeng` 提供 `Processor`：

- 窗口为半开区间 `[Start, End)`；事件时间恰好等于 `End` 时属于下一个窗口。
- `AdvanceWatermark` 只采用调用方给出的水印；处理事件不会移动水印，回退或相同的水印被忽略。
- 水印到达 `End` 时窗口关闭，并输出一个 `KindResult`。
- 关闭后、水印到达 `End+AllowedLateness` 之前，迟到事件先输出 `KindRetraction`（旧结果），再输出改正后的 `KindResult`。
- 水印到达 `End+AllowedLateness` 时窗口过期；此后的事件只产生 `KindSideOutput`，不改变结果。
- `AllowedLateness == 0` 时，窗口关闭后到达的事件全部进入侧输出。
- 关闭时没有数据因而不存在的窗口，其首条迟到事件只输出结果，不输出无意义的撤回。

撤回记录携带被撤回的旧值；需要增量应用的消费者可按顺序使用 `Output.Effect()`（结果加、撤回减、侧输出为零）。

`Options.Clock` 仅用于给输出记录盖上处理时间，不参与水印推进。`Processor` 可并发调用。

## 使用

```go
p, err := dataeng.NewProcessor(dataeng.Options{
	WindowSize:      10 * time.Second,
	AllowedLateness: 5 * time.Second,
	Clock:           myClock,
})
if err != nil {
	// handle invalid options
}

for _, out := range p.Process(event) {
	// route KindResult, KindRetraction and KindSideOutput
}
for _, out := range p.AdvanceWatermark(watermark) {
	// route outputs caused by the watermark
}
```

完整示例见 `cmd/pipeline/main.go`，运行：

```sh
go run ./cmd/pipeline
```

## 测试

`processor_test.go` 使用包外的 `manualClock` 核对改正窗口、侧输出和零迟到。所有期望值均为测试中硬编码的字面量或独立时间常量，不由被测包生成。

```sh
go test ./...
go vet ./...
```
