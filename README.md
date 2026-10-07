# 离线生产计划库及 CLI

Node.js 22，仅使用标准库与 `node:test`，离线单机执行。输入 JSON，输出计划 JSON。

## 运行

```bash
node cli.js input.json        # 从文件读取
node cli.js < input.json      # 从标准输入读取
npm test                      # 等价于 node --test
```

## 输入 JSON

```jsonc
{
  "calendar": {
    "start": "2026-01-05T00:00:00Z",   // 必须为 UTC 零点
    "days": 7,                          // 排产 horizon 天数
    "shifts": [{ "days": [1,2,3,4,5], "start": "08:00", "end": "16:00" }], // 周期班次（0=周日）
    "restDays": ["2026-01-07"],         // 休息日例外（整日剔除）
    "downtimes": [{ "start": "...", "end": "..." }] // 全局停线区间
  },
  "machines": [{ "id": "M1" }, { "id": "M2" }],
  "orders": [{
    "id": "O1", "product": "P1", "quantity": 10,
    "due": "2026-01-10T00:00:00Z",      // 可选
    "release": "2026-01-05T08:00:00Z",  // 可选，默认 0
    "route": [
      { "machines": ["M1"], "cycle": 30 },        // cycle=每件节拍(分钟)，时长=cycle*quantity
      { "machines": ["M1", "M2"], "cycle": 20 }   // 可选替代设备
    ]
    // 或链式路线（可检测循环）：
    // "route": { "steps": [{ "id": "a", "next": "b", ... }, { "id": "b", ... }] }
  }],
  "commands": [                          // 可选，依次执行
    { "type": "addOrders", "orders": [ ... ] },
    { "type": "insertRush", "order": { ... }, "budget": 1 },
    { "type": "group", "commands": [ ... ] },  // 命令组：一次 undo 单位
    { "type": "undo" }, { "type": "redo" }
  ]
}
```

## 排产规则

- 工序时长 = 固定节拍 × 数量；在设备空闲区间（日历可用时间 − 停线 − 已占用）内连续放置。
- 工序按路线先后放置，订单可在工序间等待，等待不占用设备、不计入加工。
- 订单争用同一时段的优先级：交期升序 → 数量升序 → ID 升序。
- 同一工序在多台设备上取得相同最早开始时刻时，枚举全部并列方案，
  选择设备总空闲变化最小者（受影响间隙的剩余空闲 `gapSize − duration` 最小，
  即最紧贴合），仍并列则按设备 ID 升序。
- 停线/占用夹出的零长度缝隙在区间运算中被丢弃，永不产生零长度工序。

## 急单增量重排

`insertRush(order, budget)`：按扰动订单数 k = 0,1,2,... 枚举所有被扰动订单子集，
尝试插入急单并按优先级重排被扰动订单。第一个可行且 k ≤ budget 的方案被提交（一个撤销单位）。
若最小可行 k 超过预算：状态完全不变，返回
`{ ok:false, code:"RESCHEDULE_BUDGET_EXCEEDED", required:k, budget, deficit:k-budget }`。
因为所有小于 k 的子集均已枚举并失败，缺口是可证明的。
测试中用枚举全部可行开始时刻的参考算法（`src/reference.js`）独立校验该最小值。

## 撤销/恢复

以命令组为单位：`group(...)` 内的全部修改构成一个 undo 单位；
组内任何错误整体回滚。`undo()`/`redo()` 操作组级快照栈。

## 错误 CODE

| CODE | 含义 |
|---|---|
| `INFEASIBLE` | 订单/工序无法在日历内排入 |
| `CYCLIC_ROUTE` | 链式路线存在环（含无入口步） |
| `CALENDAR_OVERLAP` | 班次或停线区间重叠 |
| `RESCHEDULE_BUDGET_EXCEEDED` | 急单重排超出扰动预算（软失败，状态不变） |
| `VALIDATION` | 输入不合法（未知设备、重复 ID、非法时间等） |

错误输出形如 `{ "ok": false, "error": { "code": "...", "message": "..." } }`，退出码 1。

## 输出

```jsonc
{
  "ok": true,
  "plan": { "orders": [{ "id": "O1", "product": "P1", "quantity": 10,
    "operations": [{ "seq": 0, "machine": "M1", "start": "...ISO...", "end": "...ISO...", "duration": 300 }] }] },
  "commandResults": [ ... ]
}
```

## 项目结构

- `src/calendar.js` — 周期班次/休息日/停线 → 可用时间轴；区间减法（零长度缝隙被丢弃）
- `src/model.js` — 订单校验、路线解析（循环检测）、优先级比较
- `src/scheduler.js` — 空闲区间、最早放置、并列枚举与最小空闲变化选择
- `src/planner.js` — 状态、命令组撤销/恢复、急单增量重排
- `src/reference.js` — 参考算法：枚举全部可行开始时刻的完备回溯搜索
- `cli.js` — 命令行入口（`execute()` 可导入）
- `examples/` — 示例输入（`demo.json` 替代设备并列；`rush.json` 急单重排）

## 测试结果（node --test）

见下方“验收记录”。

## 验收记录

1. 两订单三设备含替代设备并列选择：`test/acceptance.test.js` acceptance 1 —
   O2 第二工序在 M2/M3 上并列（同为 10:00 开始），枚举后选空闲变化更小的 M3。
2. 停线区间夹出零长度缝隙：acceptance 2 — O1 结束时刻与停线开始重合，
   零长度缝隙被跳过，O2 在 12:00 复线时开工，无零长度工序。
3. 急单重排预算不足回滚：acceptance 3 — budget=1 失败且状态逐字段不变，
   返回 `required:2, deficit:1`；参考算法（枚举全部可行开始时刻）独立确认最小扰动为 2；
   budget=2 成功且作为单个命令组可 undo/redo。

`node --test` 运行结果（2026-10-07，Node v22.22.1）：

```
✔ test/acceptance.test.js   3 项验收子测试全部通过
✔ test/planner.test.js     11 项单元测试全部通过
✔ test/cli.test.js          5 项通过 + 1 项端到端子进程测试
                              （当前沙箱禁止嵌套 spawn，按 SKIP 处理；
                               正常环境下自动执行）
ℹ tests 3  ℹ pass 3  ℹ fail 0
```
