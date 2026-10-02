# fill-release

饮料灌装线离线放行：把重量/液位（fill）、清洗（CIP）和化验（lab）事件合成批次状态，
支持化验撤回安全回滚与 CIP 边界重归属。Node.js 22，仅标准库，单机离线。

## 使用

```sh
node bin/fill.js release --in <dir> --out <dir>
# 或 npm link 之后： fill release --in <dir> --out <dir>
```

`--in` 目录下所有 `*.jsonl` 按文件名排序、按行顺序（=到达顺序）处理；`--out` 输出：

- `batches.jsonl` — 每批次最终状态（status/version/reason/聚合重量体积密度）
- `transitions.jsonl` — 仅追加的状态迁移日志，每批次 version 严格递增
- `comp.jsonl` — 补偿记录（RELEASE → HOLD 回滚，如 lab 撤回）
- `late.log` — 迟到事件（eventTs < 水位线，水位线 = 最大事件时间 - 3 分钟）

## 事件格式（每行一个 JSON）

```json
{"kind":"fill","eventTs":1000,"batch":"b1","vol":500,"weight":505,"op":"f1"}
{"kind":"cip","eventTs":0,"line":"L1","start":-60000,"end":0,"ok":true,"op":"c1"}
{"kind":"lab","eventTs":2000,"batch":"b1","pass":true,"op":"l1"}
{"kind":"retract","eventTs":3000,"target":"lab","id":"l1"}
```

`eventTs`/`start`/`end` 接受 epoch 毫秒或 ISO-8601 字符串；`op` 是操作 id，撤回按
`target`+`id` 引用。

## 语义

- 状态机：`HOLD → RELEASE → REJECT`，迁移只会沿严重度上升；唯一的逆向迁移是
  `RELEASE → HOLD` 补偿路径（lab/fill/cip 撤回触发），必定写入 `comp.jsonl`。
- 重量体积交叉校验：每个 fill 的密度 `weight/vol` 必须落在 `[0.95, 1.05]`（g/mL，
  见 `src/constants.js`）。违反即 REJECT 且不可被 lab 翻转；REJECT 是吸收态。
- `vol <= 0` 报 `VOL_INVALID`（stderr + 批次 REJECT）。
- CIP 窗口：fill 必须落在最近一次 `ok` CIP 的 `end` 之后、下一次 CIP 的 `start`
  之前。窗口不满足是**未决**（HOLD/CIP_WINDOW_PENDING），不是不可满足——迟到的
  CIP 或 CIP 撤回会使跨清洗边界的 fill 重新归属并重新求值。
- 缺 lab 固定为 HOLD；`lab.pass=false` 保持 HOLD；迟到 lab 仍可将 HOLD 翻为
  RELEASE（并记入 `late.log`）。
- lab 撤回使 RELEASE 回滚为 HOLD 并输出补偿；新 lab 可再次放行。

## 测试

```sh
node --test
```

覆盖四条验收：lab 撤回安全回滚、CIP 边界重归属、≤6 事件全枚举（1956 条序列）
对照参考状态机、重量体积矛盾保持 REJECT。结果见 `RESULTS.md`。
