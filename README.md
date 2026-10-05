# availability-monitor

多服务可用性监控库。TypeScript 编写，仅使用 Node.js 内置模块（`node:test` /
`node:assert`），无任何运行时依赖。

## 功能

- **k-of-n 最大区间**：对多个服务的可用区间（半开 `[start, end)`）做扫描线归并，
  求"至少 k 个服务可用"的最大区间，每段返回支持服务集合（排序后）。
  同一时间点上的所有增/减事件先统一结算再判定，因此一端结束、另一端同点开始的
  区间不会产生幻影空档；同一服务的重叠区间按引用计数处理。
- **因果依赖闭包**：服务可声明依赖。依赖不可用时，本服务即使在线也不计为可用。
  循环依赖按强连通分量（Tarjan）处理：分量只有全成员在线且外部依赖全部可用时
  才整体计入，否则整体坍塌（最大不动点语义）。
- **版本化净差订阅**：每次变更（增删区间、增删依赖）递增版本号；订阅者收到的是
  相对上次投递状态的净差（`added` / `removed`），并绑定同一版本号。
  `transact(fn)` 内的多次变更合并为一次净差、绑定事务结束时的版本。
- **逐 tick 对照**：测试用逐 tick 参考模型（每个整数 tick 独立做图闭包，并校验
  全来源证据：每个在线/可用服务都必须有覆盖该 tick 的源区间记录）对扫描线结果
  做全量交叉验证，包括随机增删区间与依赖后的增量对照。

## 结构

- `src/sweep.ts` — 扫描线：同点统一增减、引用计数、最大段合并、k 过滤
- `src/deps.ts` — Tarjan 强连通分量 + 有效可用性闭包
- `src/monitor.ts` — `Monitor`：区间/依赖增删、版本号、净差订阅、`transact`
- `test/tick-model.ts` — 逐 tick 参考模型与全来源证据校验
- `test/sweep.test.ts` / `test/deps.test.ts` / `test/subscribe.test.ts` /
  `test/randomized.test.ts`

## 运行

```sh
npm test        # tsc 编译到 dist/ 后用 node:test 运行
npm run typecheck
```

说明：本机 Node v22.22.1 未内置类型剥离（`ERR_NO_TYPESCRIPT`），因此 `npm test`
先用全局 `tsc`（7.0.2）编译再运行；`types/node-shims.d.ts` 提供 `node:test` /
`node:assert` 的最小类型声明，无需联网安装依赖。

## 实测结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm run typecheck`：通过，无错误。

`npm test`：4 个测试文件全部通过，共 27 个用例，0 失败：

- `test/sweep.test.ts`：7/7 通过（半开端点、同点统一增减、同服务同点续接合并、
  重叠区间引用计数、支持集合排序、非法参数拒绝、删区间精确切分）
- `test/deps.test.ts`：7/7 通过（依赖链抑制、双节点/三节点循环全有才计、
  循环+外部依赖、自依赖、未知依赖不可满足、增删依赖与区间后对照逐 tick 模型）
- `test/subscribe.test.ts`：7/7 通过（初始快照绑定当前版本、逐变更净差、
  事务合并为单净差单版本、事务内回滚净差为零、依赖变更产生更正、
  净差重放还原权威段、退订生效）
- `test/randomized.test.ts`：6/6 通过（5 个种子 × 40 步随机增删区间+依赖，
  每步对 k=1,2,3 与逐 tick 模型及全来源证据对照；另有纯区间随机对照）
