# trigger-ranker

Node.js 22（仅标准库）实现的事件时间滚动窗口 Top-3 通道电荷排名系统。

## 运行

```sh
node src/cli.js triggers --in events.jsonl
```

- stdout：JSONL 榜单动作（`ADD` / `WITHDRAW`）
- stderr：JSON 错误（每行一个，含 `line` 行号）
- 退出码：全部记录合法为 `0`，出现任何错误为 `2`

## 输入格式（events.jsonl，每行一个 JSON）

```json
{"type":"TRIGGER","eventId":"e1","version":1,"op":"UPSERT","channel":"A","ts":1000,"charge":5.5}
{"type":"TRIGGER","eventId":"e1","version":2,"op":"RETRACT"}
{"type":"WATERMARK","ts":600000}
```

- `TRIGGER` + `UPSERT`：上报通道电荷；同一 `eventId` 高 `version` 覆盖低版本。
- `TRIGGER` + `RETRACT`：撤回已存在的事件。
- `WATERMARK`：推进事件时间水位线。

## 语义

- 10 分钟（600000 ms）事件时间滚动窗口：`windowStart = floor(ts / 600000) * 600000`。
- 允许迟到 0 秒：水位线达到窗口结束时间即关闭窗口，之后落入该窗口的事件报 `LATE`。
- 窗口未关闭前，任何使榜单（Top-3 + 证书）发生变化的事件都会增量发布：
  先 `WITHDRAW` 旧榜，再 `ADD` 新榜。
- Top-3 按窗口内通道总电荷降序；并列按 `channel` 字典序。
- 证书包含窗口内全部参与 `eventIds`（排序）及每个通道的总和，可独立复核。
- `charge` 必须为有限非负数，否则报 `INVALID_CHARGE`。

## 输出动作

```json
{"type":"ADD","windowStart":0,"windowEnd":600000,"top3":[{"channel":"A","total":5.5}],"certificate":{"windowStart":0,"windowEnd":600000,"eventIds":["e1"],"channels":{"A":5.5}}}
{"type":"WITHDRAW","windowStart":0,"windowEnd":600000,"top3":[...],"certificate":{...}}
```

`WITHDRAW` 携带的是此前发布的完整榜单；窗口被清空时只发 `WITHDRAW`。

## 错误码（stderr JSON 的 `error` 字段）

| 错误 | 含义 |
| --- | --- |
| `LATE` | 事件落入已关闭窗口（含关闭后的撤回） |
| `STALE_VERSION` | 版本不高于已见版本 |
| `UNKNOWN_RETRACT` | 撤回未知事件 |
| `INVALID_CHARGE` | 电荷非有限非负数 |
| `INVALID_EVENT` / `INVALID_WATERMARK` | 记录结构非法 |
| `PARSE_ERROR` | JSONL 行解析失败 |
| `USAGE` / `IO_ERROR` | 命令行或文件读取错误 |

## 测试

```sh
node --test
```

- `test/engine.test.js`：单元与验收测试（乱序大电荷多次换榜首、并列字典序与证书复核、关闭后撤回拒绝且榜单不变等）。
- `test/reference.test.js`：独立编写的暴力参考实现（重放日志、逐窗口从零求和、排序并枚举完整榜单），与增量引擎做随机化差分对比，不共享实现代码。
- `test/cli.test.js`：CLI 的 stdout/stderr/退出码行为。
