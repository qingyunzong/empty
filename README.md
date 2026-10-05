# clearing-daycut

清算所日切（day-cut）结算引擎与 CLI。Node.js 22、仅标准库、`node:test`、单机离线。

把账户流水按**版本化时区表**与**营业日历**映射到结算日：每个结算日 `D` 的日切区间是半开区间
`[cutoff(prevBusinessDay(D)), cutoff(D))`（本地时间）。DST 缺口/重叠中的非法本地时间一律**拒绝**
（`E_GAP` / `E_OVERLAP`），绝不静默顺延。更正不删历史，只追加冲正（reversal），并仅重算受影响的
结算日。每次结算产出可验证证书：输入哈希、规则版本、区间合并结果、边界命中清单。

## 运行

```bash
npm test            # = node --test
node cli.js settle --tx examples/tx.json --tz data/tz.json --cal data/calendars.json --out report.json
node cli.js verify --tx examples/tx.json --tz data/tz.json --cal data/calendars.json --report report.json
```

## 输入格式

**时区表**（版本化，`data/tz.json`）：每个 zone 是一组 `[from, next.from)` 的固定偏移段（分钟）：

```json
{ "version": "tz-2024a-mini",
  "zones": { "America/New_York": [ {"from": "1970-01-01T00:00Z", "offset": -300},
                                   {"from": "2024-03-10T07:00Z", "offset": -240} ] } }
```

**营业日历**（版本化，`data/calendars.json`）：`zone`、`cutoff`（本地 HH:MM）、`weekend`（0=周日）、`holidays`。

**流水**（`examples/tx.json`）：

```json
{ "id": "t1", "account": "acct-a", "calendar": "NY", "amount": 10000, "utc": "2024-06-10T15:30:00Z" }
{ "id": "r1", "type": "reversal", "reverses": "t1", "utc": "2024-06-12T14:00:00Z" }
```

- 时间戳二选一：`utc`（必须带 `Z` 或偏移）或 `local`（`YYYY-MM-DDTHH:MM`，按日历 zone 严格解析）。
- 流水必须按时间非递减排列（append-only 账本），否则 `E_ORDER`。
- `hold: true` + `holdReason` 的交易计入 `pending`（未决原因），不进净额。
- 冲正把原金额的负值**记回原结算日**（as-of 更正），并把该日标记为受影响日。

## 输出

`nets`（每账户每日净额）、`pending`（未决原因）、`certificate`：

- `inputHashes`：流水 / 时区表 / 日历的 SHA-256（规范化 JSON）。
- `tzVersion` / `calendarVersion` / `engineVersion`：规则版本。
- `mergedIntervals`：冲正触发的受影响结算日合并区间（重算范围）。
- `boundaryHits`：恰好命中区间 `localStart` 边界的交易清单（半开区间，归入后一区间）。
- `certificateHash`：以上全部内容的哈希；`verify` 重放输入并比对，篡改即失败（退出码 6）。

## 错误码与退出码

| 错误 | 含义 | 退出码 |
|---|---|---|
| `E_TZ_UNKNOWN` | 未知时区 / 日历，或时区表未覆盖该时刻 | 10 |
| `E_GAP` | 本地时间不存在（DST 春季缺口） | 11 |
| `E_OVERLAP` | 本地时间歧义（DST 秋季重叠） | 12 |
| `E_ORDER` | 流水乱序、id 重复、冲正目标未知/已冲正 | 13 |

错误以 JSON 打到 stderr，CLI 非零退出。

## 库 API

```js
import { ClearingEngine, verifyReport } from './lib/engine.js';
const engine = new ClearingEngine({ tzTable, calendar });
const report = engine.settle(txs);              // 全量结算
const delta = engine.applyCorrections([...]);   // 追加冲正；delta.recomputed 列出被重算的日/合并区间
verifyReport({ tzTable, calendar, transactions }, report); // 证书重放
```

## 验收覆盖

1. **纽约/伦敦/上海同日切对照**（`test/cutover.test.js`）：同一 UTC 时刻在三个日历下切入不同结算日，
   含一次恰好 17:00 的边界命中。
2. **DST 缺口与重叠**（`test/dst.test.js`、`test/tz.test.js`）：`2024-03-10T02:30`（纽约）→ `E_GAP`，
   `2024-11-03T01:30` → `E_OVERLAP`，均拒绝而非顺延。
3. **冲正重算**（`test/reversal.test.js`）：仅重算受影响日，`recomputed.days` 精确到日；
   增量结果与全量重算的净额、证书哈希完全一致；篡改输入后 `verify` 失败。
4. **随机对拍**（`test/reference.test.js`）：确定性 PRNG 生成 200+ 笔跨三次 DST 切换的随机流水，
   与**独立实现的逐本地分钟枚举**参考算法逐笔比对结算日，并比对聚合净额。

## 真实测试输出摘要

```
$ node --test
# tests 9        # 9 个测试文件（共 30 个用例）
# pass 9
# fail 0
# duration_ms ~700-1300
```

```
$ node cli.js settle --tx examples/tx.json --tz data/tz.json --cal data/calendars.json --out /tmp/report.json
$ node cli.js verify --tx examples/tx.json --tz data/tz.json --cal data/calendars.json --report /tmp/report.json
{"verified":true,"certificateHash":"4ba91adbbb4bf2780ffbc3c19294a83fd2fb1cffd92d94769d899b144619818c"}
# verify exit=0
```

示例报告（节选）：`t1` 被 `r1` 冲正后 `NY/acct-a/2024-06-10` 净额为 0；
`mergedIntervals` 只含受影响日 `2024-06-10`；`t2`（恰好 17:00）出现在 `boundaryHits`；
`t5` 以 `AWAITING_COMPLIANCE_REVIEW` 列入 `pending`。

```
"nets": [
  { "calendar": "LN", "account": "acct-b", "day": "2024-06-11", "net": 4200 },
  { "calendar": "NY", "account": "acct-a", "day": "2024-06-10", "net": 0 },
  { "calendar": "NY", "account": "acct-a", "day": "2024-06-11", "net": -2500 },
  { "calendar": "SH", "account": "acct-c", "day": "2024-06-11", "net": 8800 }
]
```

错误示例（真实输出）：

```
$ node cli.js settle --tx gap.json --tz data/tz.json --cal data/calendars.json
{"error":"E_GAP","message":"local time does not exist in America/New_York: 2024-03-10T02:30", ...}
# exit=11
```

## 结构

- `lib/time.js` — 民用日/分钟换算（Howard Hinnant 算法），全程整数分钟，无 `Date` 依赖。
- `lib/tz.js` — 版本化时区表；`localToUtc` 严格解析（0 候选→`E_GAP`，多候选→`E_OVERLAP`）。
- `lib/calendar.js` — 营业日推算与截止时刻（cutoff 落入缺口/重叠同样报错）。
- `lib/engine.js` — 日切映射、净额、未决、冲正与增量重算、证书生成与重放。
- `cli.js` — `settle` / `verify`；同时导出 `runCli(argv)` 供进程内测试。
