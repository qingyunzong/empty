# RESULT

- 环境：Node.js v22.22.1，仅标准库，`node:test`，单机离线
- 命令：`node --test`
- 运行时间（UTC）：2026-10-03T04:36:19Z
- 结果：**全部通过（4 个测试文件，22 个用例，0 失败）**

## 真实输出（`node --test --test-reporter=spec`）

```
✔ test/bruteforce.test.js (5508.231412ms)
✔ test/cli.test.js (5029.608041ms)
✔ test/dates.test.js (6425.750386ms)
✔ test/semantics.test.js (7316.804879ms)
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

## 验收覆盖对照

| 验收项 | 测试 | 结果 |
|--------|------|------|
| A 周期继承/覆盖与撤销（更早失效点生效、待复测非作废） | `test/semantics.test.js`（4 例） | 通过 |
| B 恢复后历史仍标待复测；恢复须同机构更高等级且链接被恢复证书 | `test/semantics.test.js`（3 例） | 通过 |
| C 跨闰年边界（2024-02-29、世纪年规则、±365/366 天） | `test/dates.test.js`（4 例）+ 语义层闰年用例 | 通过 |
| D ≤30 天 / 6 器具随机场景与独立暴力实现逐日对照（含闰年窗口、撤销/恢复、反例穷举子集搜索） | `test/bruteforce.test.js`（3 例，140 个种子场景） | 通过 |
| 退出码 25/26/27（日期无效 / 机构不受信任 / 恢复链自指） | `test/cli.test.js`（5 例） | 通过 |

## 备注

- 沙箱禁止派生子进程，CLI 测试通过进程内调用 `runCli`（`lib/run.js`）完成；`cli.js` 为同等逻辑的薄入口，退出码路径一致。
- 测试中发现并修正一处测试期望错误（2025-03-01 减 366 天为 2024-02-29，库计算正确）。
