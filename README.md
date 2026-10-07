# diff-harness

差分测试工具：用**同一操作序列**驱动两个实现，逐步比较**操作结果、规范状态、事件次序**。
异步 promise 的返回时机完全由**计划（Plan）**控制，因此每次运行都可复现。

## 运行

```sh
npm test     # tsc 编译 + node:test 执行全部测试
npm run demo # 打印一份针对“故意错取消”实现的差异报告（含最小前缀与源哈希）
```

零 npm 依赖；`src/node-shims.d.ts` 提供所需的最小 Node 类型声明。

## 设计

- `src/scheduler.ts` — 计划控制的确定性调度器。所有 promise 只在 `tick`
  时按种子决定的延迟/次序兑现；同一 `(ops, plan)` 的运行结果完全一致。
- `src/sut.ts` — 被测接口（任务队列：`submit` / `cancel` / `status` / `tick`）、
  规范状态快照与确定性 JSON 序列化（对象键排序、数组保序）。
- `src/diff.ts` — 差分引擎。逐步比较 result → events → state；
  发现首个差异即停止，并输出**可复现最小前缀**（重新运行验证同签名复现）。
  序列结束时仍未完成的 promise 记入 `pendingAtEnd`，**不算失败**。
  每份报告的 `sources` 绑定两个实现源文件的 SHA-256。
- `src/impl/` — 参考实现、结构不同但行为等价的替代实现，以及
  `buggyCancelQueue.ts`：**故意错取消**（cancel 后未摘除已定时的兑现，
  之后 tick 会把任务“复活”为 done 并发出 `resolve`），仅作验收夹具。
- `test/diff.test.ts` — 验收测试：等价实现多种子一致；故意错取消必被
  检出且最小前缀可复现；未完成不等于失败；差异绑定源哈希；报告逐字节可复现。

## 报告示例（`npm run demo`）

差异在第 6 个操作（第二个 `tick`）处被发现：错误实现多发出 `resolve:j1`。
`minimalPrefix` 即为截至该操作的最短复现前缀，`sources.*.sha256`
 把差异绑定到确切的实现版本。
