# RESULTS — 测试真实摘要

- 运行时间 (UTC): 2026-10-03T10:38:22Z
- 环境: Node.js v22.22.1，仅标准库，无网络、无真实汇率
- 命令: `node --test`（另按文件 `node test/<file>` 统计子测试数）

## 总览

| 文件 | 子测试 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| test/engine.test.js | 8 | 8 | 0 | 0 |
| test/cli.test.js | 5 | 4 | 0 | 1 |
| test/enumeration.test.js | 1 | 1 | 0 | 0 |
| **合计** | **14** | **13** | **0** | **1** |

`node --test` 顶层结果：`# tests 3 / # pass 3 / # fail 0`（3 个测试文件全部通过）。

跳过 1 项：CLI 真实子进程冒烟测试。本环境沙箱禁止 `child_process.spawnSync`
（EPERM），测试内检测后 `t.skip`；CLI 逻辑改为进程内直接调用 `runCli` 全覆盖
（退出码、stderr JSON、补丁文件）。已在沙箱外手动验证真实进程行为：
`node bin/xborder.js run ev.jsonl --patch out.jsonl` → 退出码 1，
stderr `{"code":"E_BUDGET","message":"freeze p2: exposure 130 would exceed budget 100"}`，
补丁文件保留出错前的增量补丁。

## 验收映射

- **A pending 后报价转正**: `engine.test.js`「A: pending payment is not
  unsatisfiable; quote arrival turns it eligible」— 冻结后 pending 仅占最坏估计、
  不进入 eligibleSet；报价到达事件重评估后按实际汇率转 eligible，产出 `add` 补丁。
  另有 A2（报价超限转 rejected 并回滚冻结）、A3（已 eligible 付款被新报价拒绝，
  产出 `remove` 补丁）。
- **B 最坏估计边界等于预算**: 「B: worst-case estimate exactly equal to budget
  is allowed (boundary)」— `amount*worstRate == budget`（200 == 200）冻结成功；
  再加 1 单位即 `E_BUDGET`。
- **C 撤销冻结释放预算**: 「C: reverse releases the reservation and frees
  budget」— reverse 产出 `remove` 补丁并释放额度，随后同额冻结成功。
- **D 枚举对照**: `enumeration.test.js` — 8 事件池的全部 2^8 = 256 个子集
  （保序），增量引擎与独立参考实现（每次从零重算聚合 + eligibleSet 差分）
  逐一对比最终 eligibleSet、完整补丁流与错误码，全部一致；成功与报错
  （E_UNKNOWN_PAYMENT / E_BUDGET / E_ACCOUNT_REDEFINED）路径均被覆盖。

## 错误契约

- `E_BUDGET`：冻结使「已确认敞口 + pending 最坏估计」超过预算；状态不变。
- `E_RATE_STALE`：报价 `ts` 未严格大于当前 `rateTs`。
- CLI 出错：stderr 输出一行 `{"code","message"}`，退出码非 0（用法错误为 2）。
