# dedup — 恰好一次消费库（Go）

按 **（生产者ID, 序号）** 去重的消费库：效果（effect）与去重状态在
**同一批次**原子持久化，断电恢复后不会产生重复效果。

## 语义

- 每个生产者维护一个去重窗口：高水位线 + 其下 `windowSize` 个槽位的位图。
- **允许序号空洞**：高于高水位线的序号直接推进水位线；窗口内未见的
  序号（空洞回填）照常接受。
- 每条消息的去重结果为 `Accepted` / `Duplicate` / `TooOld` 之一；
  序号 ≤ 高水位线 − windowSize 时明确返回 `TooOld`（过旧），绝不重复接受。

## 同批持久化与崩溃恢复

- 接受一条消息时，把该生产者的去重窗口与消息效果序列化进**同一条记录**
  （长度 + CRC32 + 负载），一次 `Sync` 落盘——两者要么同时持久，要么同时丢失。
- 恢复时顺序扫描日志，在第一条截断/校验失败的记录处停止；未提交的尾部
  垃圾在下次写入前截断。`Compact` 通过临时文件 + rename + 目录 fsync
  原子地重写为单个快照记录。
- 提交失败（含崩溃）时内存状态不变更，消息重投即可安全重放。

## 故障注入（测试）

`FaultVolume` 包装任意 `Volume`，在每个写边界（`Append` / `Truncate` /
`Replace` / `Sync` 前后）触发钩子，钩子 panic 即模拟该点断电；`Crash`
丢弃未冲刷的暂存数据，`TornAppend` 可让部分字节"漏"到磁盘模拟撕裂写。

## 参考核验

测试用**完整序号集合**参考模型（每生产者记录全部已见序号 + 窗口过旧规则）
交叉核验：

- `TestWindowAgainstSetModel`：窗口位图与全量集合逐条决策一致；
- `TestCrashAtEveryWriteBoundary` / `TestCrashWithTornWrites`：对工作负载的
  **每一个写边界**逐一注入断电（含多种撕裂长度），恢复后效果日志与参考
  完全一致，无重复、无丢失；
- `TestRandomizedExactlyOnce`：多生产者随机流量（空洞/重复/过旧/压缩/
  随机断电），决策与效果日志均与参考模型一致；
- `TestFileVolumeEndToEnd`：真实文件卷上的重启、压缩与崩溃恢复。

## 运行

```sh
go test ./...
```

## 文件

- `window.go` — 滑动窗口位图去重（允许空洞、明确过旧）
- `store.go` — 追加式日志、同批提交、恢复截断、快照压缩
- `volume.go` — `Volume` 抽象；`MemVolume` 与 `FileVolume`（rename 原子替换）
- `fault.go` — `FaultVolume` 写边界故障注入与撕裂写模拟
- `consumer.go` — 面向使用者的 `Consumer` API
