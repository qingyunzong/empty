# 按键告警滑动时间窗显示集

TypeScript + Node.js 内置库（`node:test` / `node:assert`），无第三方运行时依赖。

## 语义

- **显示规则**：每个按键（`key`）在滑动时间窗 `[start, end)` 内只显示最早事件；
  左端含、右端不含；同时间按 `id` 小者优先。最早者被删除后次早者自动接替。
- **版本化增删**：每次变更操作（`addEvent` / `deleteEvent` / `deleteEarliest` /
  `moveWindow`）产生一个连续递增的版本和净增删 `ChangeSet`（含 `source` 来源），
  同批内被撤销的显示项不出现在净变化中。
- **订阅**：`subscribe()` 捕获首次快照，发布前的变更进入更正缓冲；发布时缓冲
  相对快照做净额合并（同段缓冲内增了又删的显示项不出现）。慢订阅积压超过容量
  时转重同步：丢弃积压、显式记录断点版本，`poll` 时给出最新全量与最新版本，
  版本号不丢。
- **可控执行器**：任务（增/删/删最早/移窗/快照发布/poll）入队后可 FIFO 或
  种子随机交错执行，每批的版本与来源记入 `log`，供连续性核对。

## 结构

- `src/model.ts` — 事件/显示项/ChangeSet 类型与排序规则
- `src/store.ts` — `AlertWindowStore`：窗口、显示集维护、版本提交、订阅管理
- `src/subscription.ts` — 快照缓冲、净额合并、容量溢出转重同步
- `src/executor.ts` — 可控执行器（FIFO / `runShuffled` 随机交错）
- `src/rng.ts` — mulberry32 可复现随机源
- `test/` — `node:test` 用例；`helpers.ts` 提供全排序扫描参照与订阅重建

## 测试

```sh
npm test    # tsc 编译后 node --test 'dist/test/*.test.js'
```

覆盖：窗口边界与同时间 ID 次序、最早删除次早接替、随机乱序插入/删除/移窗
vs 全排序扫描对照（30 种子 × 80 操作逐步比对 + 乱序/排序殊途同归）、
快照更正缓冲与净变化（同批撤销项不出现）、慢订阅重同步（断点显式、版本不丢）、
执行器交错（脚本化 + 15 种子随机）下版本连续性与来源核对、订阅流重建一致性。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
$ npm test
# tests 3   # 3 个测试文件全部通过
# pass 3
# fail 0
```

逐文件直接运行（内部用例计数）：

| 文件 | 用例数 | 通过 | 失败 |
| --- | --- | --- | --- |
| `dist/test/store.test.js` | 5 | 5 | 0 |
| `dist/test/subscription.test.js` | 4 | 4 | 0 |
| `dist/test/executor.test.js` | 2 | 2 | 0 |
| 合计 | 11 | 11 | 0 |
