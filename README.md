# netsim-helpdesk

基于 tick 的服务台（help desk）网络模拟库。TypeScript 编写，仅使用 Node.js
内置库（`node:test` / `node:assert`），零运行时依赖。

## 模型

- 网络由若干**服务台**组成，每个服务台有**有界等待队列**（`queueCapacity`，
  不含在服务客户）与若干服务台位（`servers`）。
- 客户沿固定路由依次访问服务台；入口队列满时到达客户被丢弃（计入 `dropped`）。
- **下游满时上游保留服务占位**：客户在某服务台完成服务后，若下一站的等待
  队列已满，客户不离开，继续占用当前服务台位（blocking），该台位在客户
  成功移动前无法开始新的服务。

## Tick 语义（同 tick 顺序固定）

每个 tick 依次执行四个阶段：

1. **arrive** — 源点按概率产生到达（由可序列化 RNG 驱动），入队或丢弃；
2. **complete** — 所有在服务客户推进一个 tick 的服务，剩余时间归零即完成；
3. **move** — 已完成客户向下游移动；下游队列满则保留服务占位（记 `blocked`）；
4. **start** — 空闲台位从队列取出下一位客户开工（随机服务时长入 `serviceLog`）。

因为先完成、再移动、再开工，客户可以在同一个 tick 内完成 A 站服务、
移动到 B 站并立即开工（见 `test/tick-order.test.ts`）。

## 循环等待检测

`detectCircularWait(net)`（`src/deadlock.ts`）构建等待图：服务台 A 的台位
持有已完成客户、且其目的站 B 队列满，则存在边 A→B。图中若存在环，报告
证据链（经过的服务台与被占用客户 id），并在环上所有服务台全部台位被
占位时判定为硬死锁，例如：

```
A -[customer 1]-> B -[customer 2]-> A  (hard deadlock: every server on the cycle is blocked)
```

## 快照与重放

`net.snapshot()` 返回深拷贝、可 JSON 序列化的完整状态（tick、RNG 状态、
各站队列与台位、服务日志、计数器）；`Network.restore(cfg, snap)` 恢复后
可继续逐 tick 运行。`test/snapshot.test.ts` 将快照重放与不间断的逐 tick
模型逐 tick 核对：每个 tick 的事件流、各站客户数完全一致，最终服务时间
记录（`serviceLog` 的时长与起止 tick）完全一致。

## 运行测试

需要全局可用的 `tsc`（本仓库用 TypeScript 7.0.2 验证）；`npm test` 会先
编译到 `dist/` 再用 Node 内置测试运行器执行：

```sh
npm test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
> netsim-helpdesk@1.0.0 pretest
> tsc -p tsconfig.json

> netsim-helpdesk@1.0.0 test
> node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/blocking.test.js
ok 1 - dist/test/blocking.test.js
# Subtest: dist/test/deadlock.test.js
ok 2 - dist/test/deadlock.test.js
# Subtest: dist/test/snapshot.test.js
ok 3 - dist/test/snapshot.test.js
# Subtest: dist/test/tick-order.test.js
ok 4 - dist/test/tick-order.test.js
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## 文件结构

- `src/rng.ts` — 可序列化确定性 RNG（mulberry32，状态为单个 uint32）
- `src/network.ts` — 服务台/网络模型、tick 引擎、快照与恢复
- `src/deadlock.ts` — 循环等待检测与证据报告
- `src/node-shims.d.ts` — `node:test` / `node:assert` 的最小类型声明
- `test/` — tick 顺序、阻塞占位、循环等待、快照重放四组测试
