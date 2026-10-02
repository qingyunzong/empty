# wxa — 迟到更正友好的气象观测归档

Node.js 22，仅标准库，测试用 `node:test`。单机离线运行。

## 数据模型

- **键**：`(site, validTime)`。同一键可有多个版本（初始观测 + 任意次更正）。
- **追加式事件流**：`events.log`，每行一个 JSON 事件，哈希链
  `hash = sha256(prevHash + canonical(event))`，头哈希即整流证书。
- **双时间**：`validTime`（观测时间，聚合维度）与事务序（`lamport` + 日志 `seq`）。
  版本可见性按 **(lamport, site, seq)** 全序折叠——并发合并的历史按
  lamport+site 判定先后，与到达顺序无关。
- **更正算子**：
  - `replace`：替换值（可同时改质量标记）；
  - `flag`：只改质量标记，值沿用折叠序中前一个可见版本的值（动态解析，
    因此撤销更早批次后仍能正确重新锚定）；
  - `delete`：墓碑遮蔽，**不物理删除**——历史保留，撤销 delete 批次即恢复。
- **undo**：`undo <batchId>` 追加一个补偿事件，目标批次停止可见。
  只重折叠该批次触碰过的键，其它批次（无论先后）不受影响。
- **NULL = 缺测**：聚合忽略 NULL 但保留 `nullCount` 计数。
- **质量标记**：`good`(w=1) / `suspect`(w=0.5) / `unknown`(w=0.5) / `bad`(w=0)。
  窗口置信为三值 Kleene 与：有 `bad` → `low`；否则有 `unknown` → `unknown`；
  否则有数据 → `high`；空窗/全缺测 → `unknown`。**unknown 不等同失败**：
  它照常以 0.5 权重进入均值，只把置信标为 unknown。

## 窗口聚合

每站点维护一棵按 validTime 坐标压缩的 Fenwick 树（7 个计数维度：
权重和、加权和、使用数、缺测数、删除数、bad 数、unknown 数）。
更正=点更新 O(log n)，新坐标=重建 O(n)，窗口查询=两次前缀和 O(log n)。
`src/replay.js` 提供暴力重放参照实现，测试对每个子窗口交叉比对两条路径。

## 持久化与崩溃恢复

每次提交按固定顺序写三个构件（该顺序使恢复可判定）：

1. `events.log` 追加并 **fsync** —— 故障点 1（fsync 前）
2. `index.json` 物化（tmp+rename+fsync）—— 故障点 2（索引更新后）
3. `manifest.json` 提交证书（seq、logBytes、logHash、indexHash）—— 故障点 3（清单写入后）

恢复（`recover()`，每次 open 自动执行，幂等）逐点语义：

| 故障点 | 崩溃时磁盘状态 | 恢复行为 | 结果 |
|---|---|---|---|
| 1 fsync 前 | 日志尾部未持久化（可能撕裂） | 校验哈希链，截断撕裂尾；三构件仍在上一提交点 | 事件干净丢失，状态=提交前，证书照旧可验 |
| 2 索引后 | 日志+索引含新事件，清单停留在旧 seq | 日志为权威：**前滚**——按日志重建索引并重写清单 | 无数据丢失，证书重新签发并可验 |
| 3 清单后 | 三构件一致 | 仅校验，零写入（`verify-only`） | 完全提交，直接可验 |

`verify()` 重放哈希链并核对 manifest 的 seq/logHash/logBytes/indexHash，
即"崩溃恢复后证书可验"。`audit <site@time>` 输出该键完整版本链（含每版本
哈希、所属批次、是否已撤销）与回滚边界证明（被遮蔽的 seq/哈希、恢复到的
版本），并锚定当前证书头。

## CLI

```
wxa ingest <file.jsonl> [--batch <id>]   # 每文件一个批次
wxa correct <batch.json>                 # {"batchId","corrections":[{site,time,op,...}]}
wxa undo <batchId>
wxa query <site> <from> <to>             # 闭区间，ISO-8601 或 epoch ms
wxa audit <site@time>
wxa verify
wxa recover
```

数据目录：`--data <dir>`、`$WXA_DATA` 或 `./wxa-data`。
更正条目可带显式 `lamport` 以模拟并发合并的历史。

## 库 API

`Archive.open(dir, { fault })` / `ingest` / `correct` / `undo` / `query` /
`audit` / `verify`；`recover(dir)`；`bruteForceQuery(events, site, from, to)`。
`fault: { point: 'beforeFsync' | 'afterIndex' | 'afterManifest' }` 在下一次
提交的对应阶段注入模拟机器崩溃（抛 `CrashError`），供恢复测试使用。

## 测试

```
node --test
```
