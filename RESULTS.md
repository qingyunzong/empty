# RESULTS

- 环境：Node.js v22.22.1，仅标准库；测试框架 `node:test`；命令 `node --test`
- 运行时间（UTC）：2026-10-02T14:54Z 前后，本仓库根目录

## `node --test` 实际输出摘要

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

3 个测试文件全部通过，共 15 个用例（`node --test` 顶层按文件计数）：

| 文件 | 用例数 | 结果 |
|------|--------|------|
| `test/engine.test.js` | 9 | 全过 |
| `test/cli.test.js` | 5 | 全过 |
| `test/enumeration.test.js` | 1 | 通过 |

## 验收对照

- **A（pending 后报价转正）**：`test/engine.test.js` 两条用例——`rate:null` 付款不进 eligibleSet；quote 到达后补丁 `add:[id]`。另验证报价后超预算则转 rejected（不进入集合）。
- **B（最坏估计边界等于预算）**：budget=100，pending 最坏估计 10×2=20，敞口 80 的付款 eligible 且 freeze 成功（80+20=100，边界含等号）；81 则 rejected 且 freeze 抛 `E_BUDGET`。账户预冻结额计入已确认敞口的边界（5+20+75=100 通过，76 拒绝）同文件覆盖。
- **C（撤销冻结释放预算）**：freeze 80 后 30 的付款被挤出 eligibleSet 且 freeze 抛 `E_BUDGET`；reverse 后补丁 `add:["p1","p2"]`，`confirmedExposure()` 归零。
- **D（枚举 ≤8 事件子集对照）**：`test/enumeration.test.js` 对 8 事件池的全部 2^8=256 个子集（保持池内顺序），逐事件比较增量引擎与"从头重放"的独立参考实现：eligibleSet 完全一致（676 个前缀步），补丁流可重建同一集合，错误码与出错位置一致（256 个子集中 220 个以错误终止，双方 code 相同）。实测日志：`subsets verified: 256, prefix steps compared: 676, subsets ending in error: 220`。

## CLI 端到端（`test/cli.test.js`）

- 正常流：退出码 0，`out.jsonl` 只含增量补丁行（如 `{"seq":3,"add":["p1"],"remove":[]}`）。
- `E_BUDGET` / `E_RATE_STALE`：退出码非 0，stderr 为单行 JSON `{"code","message"}`；出错前已产生的补丁仍写入 `--patch` 文件。
- 用法错误：非 0 退出并打印 usage。

## 备注

- 未使用网络与真实汇率；汇率全部来自事件流（`quote` / `payment.rate` / `account.worstRate`）。
- 沙箱中 spawn 的子进程管道 stdout/stderr 会被丢弃（EPERM），CLI 测试改为将子进程 stdio 重定向到临时文件再断言，不影响被测代码路径。
