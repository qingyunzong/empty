# clearing-house

支付清算所结算引擎：按事件时间将商户流水聚合到 5 分钟滚动窗口，输出净额与可验证证书。仅依赖 Node.js 22 标准库。

## 用法

```sh
node cli.js settle --in events.jsonl --wm 3000 --out out.jsonl [--naive]
node --test
```

- `--in`：输入 JSONL，每行一个事件 `{"type":"auth|capture|void","id","mch","amt","ts"}`（`ts` 毫秒，`void` 可省略 `amt`）。
- `--wm`：水位线滞后（毫秒）。水位线 = 已见最大 `ts` − 滞后。
- `--out`：输出 JSONL。
- `--naive`：对 ≤200 事件额外做全量重放并与流式结果比对，不一致退出 3。

## 语义

- 窗口固定 5 分钟（300000ms），按 epoch 对齐；`winEnd <= 水位线` 时关闭并输出 `status:"final"`；EOF 时冲刷所有剩余窗口。
- 水位线推进前允许乱序；`ts < 水位线` 的事件记为 `{code:"LATE"}` 且不入账。
- `auth`/`capture` 以 `amt`（整数分）正向入账；同一 `id` 的第二次 `auth`/`capture` 为业务冲突，记 `{code:"CONFLICT",reason:"duplicate-id"}`，首条有效、绝不双计，处理继续。
- `void` 撤回同 `id` 的入账：目标窗口未关闭则从窗口中撤除；窗口已关闭则输出 `status:"correction"`、`net:-amt` 的更正记录，不改写历史。未知或已撤回的 `id` 记 `CONFLICT`（`void-unknown-id`）。

## 输出格式

窗口/更正记录每行：

```json
{"winStart":0,"winEnd":300000,"mch":"m1","net":1200,"cert":"<sha256 hex>","status":"final|correction"}
```

行内诊断记录：`{"code":"LATE"|"CONFLICT","line":N,"id":...,"reason"?...}`。

## 证书（可重算）

规则版本 `clearing-v1`。证书与事件到达顺序无关，任何持有相同有效入账集合的验证方均可重算：

- 窗口证书：`sha256("clearing-v1|winStart|winEnd|mch|id:kind:amt,...")`，条目按字符串排序。
- 更正证书：`sha256("clearing-v1|correction|winStart|winEnd|mch|id:amt")`。

## 退出码

- `0` 成功；`1` 用法/IO 错误；`2` 输入数据错（非法 JSON、amt 非整数分或为负等，stderr 报行号）；`3` `--naive` 比对不一致。

## 结构

- `cli.js` — 命令行入口（导出 `run()` 便于进程内测试）
- `lib/parse.js` — JSONL 解析与校验（`DataError` 携带行号）
- `lib/engine.js` — 流式增量引擎
- `lib/naive.js` — 朴素全量重放（差分对照）
- `lib/cert.js` — 规范化与 sha256 证书
