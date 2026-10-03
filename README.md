# 计量校准状态引擎（metrology-calibration）

计量室管理扭矩扳手（torque_wrench）与量块（gauge_block）的校准证书，
向生产系统提供"器具可用"证明。仅 Node.js 22 标准库，`node --test` 测试。

## 运行

```bash
node src/cli.js run --dir examples --as-of 2024-08-01
#   读取 <dir>/instruments.json, calibrations.jsonl, usage.jsonl
#   写出 <dir>/status.json 与 impact.jsonl（--status-out/--impact-out 可覆盖）
node src/cli.js counterexample --dir examples --work-order WO-1003 --as-of 2024-08-01
```

库接口见 `index.js`（`buildState` / `instrumentUsableAt` / `measurementStatus` /
`workOrderStatus` / `findMinimalRevocations` / `bruteForceMinimalRevocations`）。

## 数据模型

**instruments.json**：`trusted_institutions`（受信任机构）、
`instrument_types`（类型默认校准周期 `calibration_interval_months`）、`instruments`。

**calibrations.jsonl**（事件流）：

- `{"event":"issue","cert":"C1","instrument":"TW-1","institution":"NIM","level":1,"issued":"2024-01-10","valid_months":6}`
  — 个体证书 `valid_months` 覆盖类型周期；`level` 用于恢复等级判定（缺省 1）。
- `{"event":"revoke","cert":"C1","date":"2024-06-01"}` — 撤销，自该日起失效。
- `{"event":"restore","cert":"C1","by":"C2","date":"2024-07-01"}` — 用证书 C2 恢复 C1。

**usage.jsonl**：`{"work_order":"WO-1","measurement":"M1","instrument":"TW-1","date":"2024-03-01"}`。

## 核心语义

1. **周期继承与覆盖**：器具类型定义默认校准周期；个体证书的 `valid_months` 覆盖之。
   有效期为 `issued <= d < expiry`，`expiry = issued + 校准月数`（按日历月，月末钳制）。
2. **更早失效点生效**：撤销日早于到期日时，撤销生效，即失效点为 `min(expiry, revoke_date)`。
   失效点之前的已合格测量**不作废**，标记 `pending_retest`（待复测）；
   失效点之后的测量为 `invalid`。
3. **恢复**：只能由**同机构、更高等级**的证书完成，且必须链接被恢复证书
   （`by` 字段）。恢复自恢复日起重新打开有效期，但被撤销区间的污染是永久的：
   该区间内的历史测量仍标 `pending_retest`；恢复区间内的测量为 `qualified`。
4. **审计**：`--as-of` 重放不早于该日期的事件，可从任意日期重算可用集合。
5. **反例（最少撤销）**：对当前为 `ok` 的工单，找出使其变为非 `ok`
   （`retest_required` 或 `illegal`）的最少撤销集合——即该工单某条测量的
   全部未污染覆盖证书。`findMinimalRevocations` 直接求解，
   `bruteForceMinimalRevocations` 枚举全部撤销子集做对照（验收 D）。

## 工单状态

- `ok`：全部测量 `qualified`；
- `retest_required`：存在 `pending_retest`，无 `invalid`；
- `illegal`：存在 `invalid`（无证书覆盖或器具未知）。

## 错误退出码

| 码 | 含义 |
|---|---|
| 25 | 日期无效（非法格式或不存在的日期，如 2023-02-29） |
| 26 | 机构不受信任（issue 事件的机构不在 trusted_institutions） |
| 27 | 恢复链自指（cert 恢复自身，或恢复链成环） |
| 1  | 其他语义错误（恢复机构不符/等级不足、证书重复、未知器具等） |

## 测试

```bash
node --test
```

- `test/dates.test.js` — 闰年规则、日期校验、闰日边界加减月。
- `test/engine.test.js` — 验收 A（周期继承/覆盖、撤销与到期取早）、
  B（恢复后历史仍待复测）、C（跨闰年边界）、任意日期审计重算。
- `test/counterexample.test.js` — 验收 D：<=30 天 / 6 器具随机场景，
  直接解与暴力枚举对照（300 场景，365 个 ok 工单）。
- `test/cli.test.js` — 端到端输出与退出码 25/26/27/1。
