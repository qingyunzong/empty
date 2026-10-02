# fill-release

饮料灌装线离线放行引擎：把重量/液位（fill）、清洗（CIP）与化验（lab）事件合成为批次状态，
支持化验与清洗撤回的确定性回滚。Node.js 22，仅标准库，单机离线。

## 用法

```bash
node bin/fill.js release --in <dir|file> --out <dir> \
  [--density-min 0.95] [--density-max 1.10] [--watermark-lag-ms 180000]
npm test   # node --test
```

输入为 JSONL（`--in` 为目录时按文件名排序读取全部 `*.jsonl`），每行一个事件：

```json
{"type":"fill","eventTs":1000,"batch":"B1","vol":500,"weight":500,"op":"f1"}
{"type":"cip","eventTs":0,"line":"L1","start":-2000,"end":-1000,"ok":true,"op":"cip0"}
{"type":"lab","eventTs":2000,"batch":"B1","pass":true,"op":"l1"}
{"type":"retract","eventTs":3000,"kind":"lab","id":"l1"}
```

`eventTs`/`start`/`end` 接受 epoch 毫秒或 ISO-8601 字符串。输出写入 `--out`：

- `batches.jsonl` — 每批次终态：`state/reason/fillCount/window/labs/watermark`
- `transitions.jsonl` — 仅追加的审计日志，`seq` 全局单调递增
- `comp.jsonl` — 撤回驱动的补偿记录（如 RELEASE→HOLD 回滚）
- `late.log` — 迟到事件（事件时间落后于水位线，或 lab 到达时本批 fill 窗口已被水位线关闭）

## 语义

- 水位线 = 已见最大事件时间 − 3 分钟；迟到事件记录到 `late.log` 但仍生效（离线对账），
  迟到 lab 可以把 HOLD 改为 RELEASE。
- 批次基态是"活跃 fill + 活跃 CIP"的纯函数：
  - 无 fill → `EMPTY(NO_FILL)`
  - `vol <= 0` → `REJECT(VOL_INVALID)`
  - 密度 `weight/vol` 越出 `[0.95, 1.10] g/mL` → `REJECT(DENSITY_MISMATCH)`
  - fill 未落在"最近一次 ok CIP 结束之后到下一次 CIP 开始之前" → `REJECT(CIP_WINDOW)`
  - 否则 → `HOLD(AWAITING_LAB)`：缺 lab 固定 HOLD，未决 ≠ 不可满足
- lab 按到达序应用且仅作用于 HOLD：`pass → RELEASE`，`fail → REJECT(LAB_FAIL)`；
  REJECT 对 lab 吸收（任何 lab 都不能翻转 REJECT，尤其密度矛盾）。
- `retract` 按 `kind+id` 移除事件并确定性重算：lab 撤回使 RELEASE 安全回 HOLD 并写
  `comp.jsonl`；CIP 撤回会消除清洗边界，跨边界 fill 重新归属（可能 REJECT→HOLD）；
  未知/类型不符的撤回是幂等 no-op。重复 `op` 幂等忽略。
- 可审计性：状态迁移只追加、不回改；回滚以带原因的新迁移 + 补偿记录表达，
  `seq` 单调递增，任意时刻可由事件流重放复现。

## 假设

- 单生产线：CIP 边界对所有批次全局生效（fill 事件不携带线别）。
- 任何 CIP（无论 ok 与否）的 `start` 都构成清洗边界；只有 `ok` CIP 的 `end` 打开洁净窗口。
- 密度默认区间 0.95–1.10 g/mL（水基饮料），可用 CLI 参数覆盖。

## 结构

- `src/events.js` — JSONL 解析与字段校验
- `src/engine.js` — 状态机、水位线、撤回重算、审计/补偿/迟到日志
- `src/cli.js` + `bin/fill.js` — `fill release` 命令
- `test/` — node:test：lab 撤回回滚、CIP 边界重归属、≤6 事件全枚举对照独立状态机
  （55986 条序列）、密度矛盾不可翻转、CLI 端到端
