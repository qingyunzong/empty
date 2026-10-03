# xborder-recon

跨境收单对账库 + CLI。Node.js 22、仅标准库、单机离线、`node:test`。
交易 UTC 时间、商户本地入账日、费率生效区间分别使用**各自独立版本**的时区转换表；
表可热更新（注册新版本），但重算必须按版本固定（pinned），禁止用当前表改历史。

## 运行

```bash
node --test                                  # 全部测试
node bin/cli.js reconcile examples/reconcile.json
node bin/cli.js convert   examples/convert.json
```

## 时区表格式（版本化）

```json
{
  "version": "stl-v2",
  "zones": {
    "Merchant/Shanghai": {
      "transitions": [
        { "utc": "2020-01-01T00:00:00Z", "offsetMinutes": 480 },
        { "utc": "2024-06-01T00:00:00Z", "offsetMinutes": 420 }
      ],
      "leapMap": { "2016-12-31T23:59:60Z": "2017-01-01T00:00:00Z" }
    }
  }
}
```

- `transitions`：UTC 生效时刻 → 偏移（分钟）。某 UTC 的偏移 = 最后一个不晚于它的 transition；
  首个 transition 之前使用首个偏移。
- `leapMap`：**闰秒式边界**（秒=60 的时间戳）必须按表显式映射，否则抛 `E_TZVER`。
- 表注册进 `TzRegistry` 的三种用途（purpose）：`txn`（交易时间解析）、`settlement`
  （商户本地入账日）、`fee`（费率区间本地时间→UTC）。同一 version 内容不可变：
  重复注册相同内容是幂等热加载，注册不同内容抛 `E_TZVER`；热更新 = 注册新版本。

## 本地时间二义性策略

`localToUtc(table, zone, local, policy, evidence)`，policy ∈ `strict | earlier | later`：

- **重复本地时间**（回拨重叠）：`strict` 抛 `E_AMBIG`；`earlier`/`later` 取较早/较晚的 UTC。
- **不存在本地时间**（拨快空洞）：`strict` 抛 `E_AMBIG`；`earlier` 取空洞前最后一个有效
  瞬间，`later` 取空洞后第一个有效瞬间。
- 未知 policy 抛 `E_POLICY`。每次非唯一解析都会写入 evidence（类型、表版本、候选、
  策略、解析结果），随对账结果一并输出。

## 对账输入 / 输出

CLI `reconcile` 读取离线 JSON（见 `examples/reconcile.json`）：

- `pinned: {txn, settlement, fee}`：本次运行固定的三个表版本（缺版本 → `E_TZVER`）。
- `rates`：费率/汇率区间，本地时间 `[startLocal, endLocal)`，按 fee 表解析为 UTC 半开区间。
- `transactions` / `corrections` / `settlements`：交易流水、修正流水（`supersedes` 原交易）、
  渠道实际入账。

输出：

- `differences`：按商户本地入账日的 expected/actual/diff/status
  （`match | mismatch | missing_actual | missing_expected`）。金额以最小货币单位整数字符串
  表示，费率/汇率按十进制有理数 half-up 舍入。
- `rateHits`：每笔交易命中的费率区间（区间重叠时取生效最晚者）。
- `impactSet`：修正流水触发的影响集 —— 仅旧/新 UTC 瞬间**相交**的费率区间、入账日、
  交易；其余区间不重算。
- `evidence`：全部二义性/空洞解析凭证。
- `versions`：本次运行实际使用的固定版本三元组。

## 历史不可改写（E_REPLAY）

`engine.reconcile(input, {finalize: true})` 会把每个入账日的版本三元组定稿。
之后对同一入账日使用**不同**版本三元组重算会抛 `E_REPLAY`；相同版本的重算是幂等允许的；
修正流水通过新增记录（而非改写）影响已定稿日期。

## 错误码

| 码 | 含义 |
|---|---|
| `E_TZVER` | 表版本未知 / 同版本内容冲突 / 闰秒边界无显式映射 / 时区缺失 |
| `E_AMBIG` | strict 策略下本地时间重复或不存在 |
| `E_POLICY` | 未知策略、非法时间戳/金额、非法区间配置等 |
| `E_REPLAY` | 用不同表版本重写已定稿历史 |

## 结构

- `src/time.js` — 民用历法换算、UTC/本地时间戳解析（含闰秒式边界显式映射）
- `src/registry.js` — 版本化、只增不改的表注册中心
- `src/convert.js` — UTC↔本地转换、三策略解析、evidence 记录
- `src/engine.js` — 对账引擎：入账日分桶、费率命中、差异、影响集、E_REPLAY 防护
- `src/reference.js` — 仅供测试的逐分钟展开参考算法
- `src/cli.js` + `bin/cli.js` — CLI（`reconcile` / `convert`）

## 测试摘要（真实运行结果）

`node --test`（Node v22.22.1）：**5 个测试文件、18 个用例，全部通过，0 失败**
（最近一次运行约 0.7s）。

- `test/tzver.test.js`（4）：验收 1 —— 同一 UTC（2024-06-01T16:30:00Z）在 stl-v1(+8)
  落入 2024-06-02、在 stl-v2(+7) 落入 2024-06-01；未知版本/版本内容冲突 → `E_TZVER`；
  闰秒式边界按表显式映射、缺映射 → `E_TZVER`。
- `test/ambig.test.js`（5）：验收 2 —— 重叠本地时间 2024-10-27T02:30:00 三策略结果
  （strict→`E_AMBIG`，earlier→00:30:00Z，later→01:30:00Z）重复运行完全一致且证据入
  evidence；空洞时间 2024-03-31T02:30:00 三策略夹取边界；非法策略 → `E_POLICY`。
- `test/reconcile.test.js`（4）：验收 3 —— 修正流水把 t1 从 3 月移至 4 月，影响集精确
  为 `{r-mar, r-apr}`（不含 r-may）；端到端差异/费率命中；已定稿入账日用 stl-v2 重算
  → `E_REPLAY`。
- `test/fuzz.test.js`（2）：验收 4 —— 确定性 PRNG 生成随机时区表（10 组 × 40 样本），
  UTC→本地与本地→UTC 候选集均与逐分钟展开参考算法逐一核对一致。
- `test/cli.test.js`（3）：CLI reconcile/convert 示例输入端到端及错误 JSON 输出。
