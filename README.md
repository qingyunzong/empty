# alert-window-store

告警库：按键（key）聚合，在滑动时间窗内每个 key 只显示**最早**事件（同刻按 ID 字典序决胜），
窗口为**左含右不含** `[start, end)`。最早事件被删除后，次早事件自动接替显示。
纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零 npm 运行时依赖。

## 运行

```sh
npm test        # tsc 编译 + node --test 运行全部测试
npm run build   # 仅编译到 dist/
npm run typecheck
```

环境要求：Node.js（开发于 v22.22.1）与 TypeScript 编译器（开发于 tsc 7.0.2）。
`types/node-shims.d.ts` 内置了所用 Node 内置模块的最小类型声明，无需安装 `@types/node`。

## 设计

- `src/store.ts` — `AlertWindowStore`
  - 每个 key 的事件按 `(time, id)` 有序存放，二分定位窗内最早事件。
  - 每次变更（`upsert` / `remove` / `moveWindow` / `transaction`）提交一个批次（Batch）：
    版本号严格 +1 连续递增，携带来源（`upsert`/`remove`/`window`/`transaction`）。
  - 批次增删通过对批前/批后显示集做差得到，天然**净额结算**：同批内被撤销的显示项不出现在净变化中。
  - 订阅（`subscribe({ maxQueue })`）：
    - 订阅即捕获快照；快照发布前的变更作为**更正缓冲**，发布时按序回放（快照 → 增量批次）。
    - 慢订阅缓冲批次超过 `maxQueue` 即转为**重同步**：丢弃增量，下发 `resync` 消息，
      携带 `fromVersion`（最后送达版本）与当前 `version`，版本链不丢失；
      快照发布前超额则直接以当前版本重新快照。
- `src/reference.ts` — 参考模型：全量事件按 `(time, id)` **全排序后扫描**，取每个 key 窗内首个事件。
- `src/executor.ts` — 可控执行器 `Harness`：由种子 PRNG（mulberry32）驱动，交错执行
  随机插入、**删除最早事件**、**窗移动**、**创建订阅（快照）**，每步核对：
  版本连续且来源正确、批次净变化可精确重放到新显示集、
  存储与全排序扫描参考模型一致、各订阅者版本连续并最终收敛（含 resync）。
- `src/prng.ts` — 确定性种子随机数与乱序工具。

## 测试与实际结果

`npm test` 实际输出（2026-10-05，Node v22.22.1，tsc 7.0.2）：

```
# Subtest: dist/test/executor.test.js
ok 1 - dist/test/executor.test.js
# Subtest: dist/test/store.test.js
ok 2 - dist/test/store.test.js
# Subtest: dist/test/subscription.test.js
ok 3 - dist/test/subscription.test.js
# tests 3
# pass 3
# fail 0
```

逐条用例（15 条全部通过）：

```
ok 1 - 受控执行器交错删除最早事件、窗移动和快照，核对连续版本及来源
ok 2 - 相同种子的执行完全确定
ok 1 - 每个 key 只显示窗口内最早事件，同刻按 ID 决胜
ok 2 - 窗口左端包含、右端不包含
ok 3 - 删除最早事件后次早事件接替显示
ok 4 - 插入更早事件会取代当前显示，更晚事件不影响显示
ok 5 - 移动窗口输出显示集增删，版本连续且来源正确
ok 6 - 随机乱序插入与全排序扫描结果一致
ok 7 - 同事务内的增删被净额结算，不含已被撤销的显示项
ok 8 - 窗口参数非法时抛错
ok 1 - 首次快照期间更正被缓冲，发布后按序回放
ok 2 - 发布后净变化不含同批撤销的显示项
ok 3 - 慢订阅超额转重同步，版本链不丢失
ok 4 - 快照发布前超额则直接以当前版本重快照
ok 5 - 关闭后不再接收消息
```
