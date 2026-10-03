# Metrology Calibration Tracker

计量室器具（扭矩扳手 / 量块）校准状态库与 CLI。仅 Node.js 22 标准库，单机离线。

## 运行

```sh
node cli.js --instruments instruments.json \
            --calibrations calibrations.jsonl \
            --usage usage.jsonl \
            --as-of 2025-07-15 \
            --status-out status.json \
            --impact-out impact.jsonl
# 反例（最少撤销使某工单从合法变非法）：
node cli.js ... --counterexample WO-1 --revoke-at 2025-06-15
```

测试：`node --test`

## 输入

- `instruments.json`：`trustedInstitutions`（受信任机构）、`types`（类型 → `calibrationIntervalDays`）、`instruments`（`id` + `type`）。
- `calibrations.jsonl`（每行一个事件）：
  - `{"kind":"certificate","id","instrument","institution","level","date","intervalDays"?}` — `intervalDays` 缺省时继承器具类型周期（个体证书覆盖类型）。
  - `{"kind":"revocation","certificate","date"}`
  - `{"kind":"reinstatement","certificate","reinstates","date"}` — 恢复证书须与被恢复证书同机构、同器具、等级严格更高，且恢复当日自身有效。
- `usage.jsonl`：`{"workOrder","instrument","date","result"?}`（`result` 默认 `"pass"`）。

## 核心语义

- 证书有效期为半开区间 `[签发日, 签发日 + 周期)`；撤销与超期冲突时**更早失效点生效**。
- 被撤销证书覆盖的已合格测量标记 `pending_retest`（待复测）而非作废；恢复后历史仍保持 `pending_retest`，仅恢复后新测量为 `valid`。
- 器具在某日可用 ⇔ 存在覆盖该日的有效证书段。
- 审计：`--as-of` 可从任意日期重算可用集合（`status.json`）。
- 反例：在 `--revoke-at T` 撤销证书会移除其在 `d ≥ T` 的全部覆盖；使工单非法的最少撤销 = 覆盖某单一用工日期（`d ≥ T`）的最小证书集合。

## 输出

- `status.json`：截至 `--as-of` 各器具可用性、当前证书、到期日。
- `impact.jsonl`：受影响的在制工单测量（`pending_retest` / `illegal`），含原因与撤销日期。
- `--counterexample` 时 stdout 打印最少撤销集合 JSON。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功 |
| 2  | 输入校验错误（结构、引用、恢复规则等） |
| 25 | 日期无效 |
| 26 | 机构不受信任 |
| 27 | 恢复链自指/成环 |
