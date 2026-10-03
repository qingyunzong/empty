# wxa — 气象观测归档（迟到更正 / 批次撤销 / 质量加权窗口聚合）

Node.js 22，仅标准库，测试使用 `node:test`。单机离线运行。

## 数据模型

- **Append-only 事件流**：所有状态变更（`obs` / `batch_open` / `undo`）以 JSONL 追加到
  `<data>/events.log`，每个事件带全局单调递增的 **lamport** 时钟与内容寻址的
  `eventId`（规范化 JSON 的 SHA-256）。
- **键**：`site|validTime`（ISO 8601 UTC）。同一键可有多个版本，按 lamport 排序，
  有效值（tip）= 未被撤销版本中 lamport 最大者；并发历史按 **lamport + site** 判定先后。
- **更正三种 op**：
  - `replace`：写入新值/新质量标记；
  - `flag`：保留数值，附加 flags（可顺带改质量标记）；
  - `delete`：逻辑遮蔽（tip 标记 deleted，聚合跳过），**不物理删除**，版本链完整保留，
    撤销该批次后原观测自动恢复。
- **NULL = 缺测**：聚合时忽略其值，但 `nullCount` 计数保留（`total = nonNull + nullCount`）。
- **质量权重**：`good=1.0, suspect=0.5, unknown=0.25, bad=0.0`。
  加权均值 = Σ(value·w) / Σw（Σw=0 时为 null）。
- **三值置信**：`ok / unknown / fail`。`unknown` 质量标记使窗口置信为 `unknown`，
  **不等同失败**；`suspect`/`bad` 使窗口置信为 `fail`。窗口置信取所有有效观测的最差级。

## 窗口聚合的增量维护

内存索引 `windowIndex` 以 `site|day` 为粒度维护累加器
`{weightedSum, weightSum, nonNull, nullCount, ok, unknown, fail}`，
只反映**有效 tip**（不是原始追加）：新 obs 事件到达时减去旧 tip、加上新 tip；
`undo` 时对受影响键重算 tip 并做同样的差量调整。查询时：

- 完整覆盖的天直接合并日粒度累加器（O(天数)）；
- 窗口两端不足一天的部分暴力重放该键的版本链；
- `--brute`（或 `WXA_BRUTE=1`）全程暴力重放，用于对拍验证。

测试保证交错更正 / 随机操作序列下，增量索引结果与暴力重放逐字段一致。

## 持久化与崩溃恢复

每次提交（ingest / correct / undo）的写序：

1. 追加事件到 `events.log`（`appendFileSync`）并更新内存索引；
2. **故障点 preFsync**：fsync 之前崩溃 —— 未冲刷的字节随 OS 缓冲区丢失
   （模拟：崩溃时把日志截断回上一个已持久化边界）。恢复后该批次**完全不存在**，
   状态等于上一次成功提交。
3. fsync 日志（数据落盘）；
4. **故障点 postIndex**：fsync 之后、清单写入之前崩溃 —— 事件已持久化但
   `manifest.json` 仍是旧的。恢复时重放日志中超出清单 lamport 的事件，
   该批次**完整恢复**，并刷新清单到最新 lamport。
5. 原子写清单（tmp 文件 + fsync + rename），记录 `committedLamport`；
6. **故障点 postManifest**：清单落盘后崩溃 —— 全部已提交，恢复为无操作，
   撤销记录与证书均可验证。

恢复规则（`_load`）：重放整段日志；若末行是不可解析的撕裂写，截断回清单边界；
若日志领先清单，刷新清单；若清单领先日志（未冲刷尾部丢失），以日志为准。

## 回滚边界证明（证书）

`certificate <batchId>` 导出：批次 lamport、事件 ID 列表、undo 事件 ID、
受影响键集合及每个键的完整版本链审计。`verify` 对当前归档重放校验：

- 每个受影响键的审计链与证书一致；
- 目标批次事件的 `undone` 标志与证书声明一致；
- 其他批次事件未被误撤销（undo 只影响目标批次）。

## CLI

```sh
export WXA_DATA=.wxa          # 数据目录，默认 .wxa
wxa ingest obs.jsonl          # 每行 {site, validTime, value|null, quality, flags?}
wxa correct batch.json        # {batchId, corrections:[{op,site,validTime,value?,quality?,flags?}]}
wxa undo <batchId>
wxa query <site> <from> <to>  # 半开区间 [from, to)，ISO 8601 UTC
wxa audit <site|validTime>    # 键的完整版本链与 tip 状态
wxa certificate <batchId>     # 导出回滚边界证书
wxa verify <cert.json>        # 对当前归档验证证书
```

环境变量：`WXA_BRUTE=1` 强制暴力重放；`WXA_AS_OF_LAMPORT=n` 事务时间回滚查询；
`WXA_CRASH_AT=preFsync|postIndex|postManifest` 注入崩溃点。

## 测试

```sh
node --test test/
```
