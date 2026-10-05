# availability-monitor

多服务可用性监控库（TypeScript，仅依赖 Node.js 内置模块，零 npm 依赖）。

## 功能

- **k-of-n 最大区间**：对多个服务的在线区间做扫描线聚合，求"至少 k 个服务可用"的
  最大半开区间 `[start, end)`，并返回每段恒定不变的支持服务集合。
- **同点统一增减**：同一时刻的所有区间端点事件先合并应用，再判定该点之后开区间的
  计数，保证拼接点处不产生缝隙也不重叠。
- **因果依赖闭包**：服务依赖不可用时，本服务虽在线也不计可用；循环依赖组件
  （Tarjan SCC）只有全成员在线、且组件外部依赖全部可用时才计入。
- **订阅净差更正**：订阅某 k 值视图后，每次增删区间/依赖只发送净差
  （`added`/`removed`，两侧相同的段抵消），并绑定同一单调递增版本号。
- **逐 tick 对照模型**：`TickModel` 对每个整数时刻独立做在线判定 + 依赖图最大
  不动点闭包，并产出每服务的全来源证据（自身在线、各依赖可用、最终判定），
  用于交叉验证扫描线结果。

## 结构

- `src/intervals.ts` — 半开区间集合的规范化、增删、交、覆盖判定
- `src/scc.ts` — Tarjan 强连通分量（发现循环依赖组件）
- `src/monitor.ts` — `AvailabilityMonitor`：状态维护、依赖闭包、扫描线、订阅
- `src/tickModel.ts` — 逐 tick 参考模型与全来源证据
- `test/` — 23 个用例：扫描线语义、依赖闭包（链/环/菱形/增删）、
  6 组种子随机增删对照逐 tick 模型、订阅净差与版本绑定

## 测试

```sh
npm test    # tsc 编译后用 node:test 运行 dist/test/*.test.js
```

## 实际测试结果（2026-10-05，Node v22.22.1）

```
ok 1 - dist/test/crosscheck.test.js
ok 2 - dist/test/deps.test.js
ok 3 - dist/test/subscribe.test.js
ok 4 - dist/test/sweep.test.js
# tests 4
# pass 4
# fail 0
```

4 个测试文件、23 个用例全部通过，0 失败。
