# dedup — 按 (生产者ID, 序号) 去重的消费库

## 语义

- `Apply(producer, seq, ops...)` 返回三种判定：
  - `New`：首次出现，效果 `ops` 与去重标记**同一批**追加进 WAL 并 fsync；
  - `Duplicate`：窗口内已见，不应用任何效果；
  - `TooOld`：序号低于滑动窗口（`maxSeq - seq >= windowSize`），明确按"过旧"拒绝，不应用效果。
- 允许序号空洞：窗口内未见的序号以位图空位表示，可迟到补投；空洞随窗口前移老化为过旧。
- 每条 WAL 记录同时携带去重标记 `(producer, seq)` 与效果，二者同生共灭，
  因此断电后不会重复效果：记录幸存则重投被判为重复，记录丢失则消息从头重处理。
- 恢复时顺序重放帧（`len | CRC32 | payload`），在首个无效/撕裂帧处截断。
- 写边界出错后 DB 进入粘性错误态，必须关闭重开（重开即恢复）。

## 文件

- `dedup.go` — 每生产者滑动窗口位图去重核心（`Set.Observe`）。
- `db.go` — WAL 编解码、批量 `Apply`、崩溃恢复。
- `storage.go` — 存储边界抽象 `File`（每个方法都是故障注入点）与 OS 实现。
- `fault_test.go` — 故障注入存储（volatile/durable 分离，Sync 才持久；
  支持撕裂写）、逐写边界崩溃扫描、完整序号集合参考模型核验。
- `db_test.go` — 持久化重开、撕裂尾/CRC 损坏恢复、粘性错误等测试。
- `dedup_test.go` — 窗口语义单元测试（空洞、边界、大跳变）。

## 测试

```sh
go test ./...        # 全部测试
go test -race ./...  # 竞态检测
```

`TestWriteBoundarySweep` 对一次确定性运行的**每一个**写边界
（WriteAt / Truncate / Sync）逐一注入断电并核验；
`TestRandomizedCrashesVsReference` 以完整序号集合为参考模型，
在随机空洞/重复/过旧负载与多次随机断电（含撕裂写）下核验判定与最终效果状态一致。
