# gs-sched — 卫星地面站科学数据下行排程

Node.js 22，仅标准库与 `node:test`，无第三方依赖。

## 命令

所有命令支持 `--dir DIR`（默认 `$GS_DIR` 或 `./.gs`），状态由哈希链日志
`<dir>/journal.log` 确定性重放得到。

- `pass add --id P --task T --start S --end E --elev D --rate R --onboard B [--quota Q] [--min M] [--priority N] [--setup S] [--max-rate R]`
  注册过顶；`--quota/--min/--priority` 定义任务日配额与最小保障。
- `pass confirm --id P` 将已排程字节标记为已传（锁定，不可抢占/撤销）。
- `pass list` 列出过顶与任务。
- `schedule [--setup S]` 计算排程：输出秒级时间线、丢包责任（weather/
  conflict/quota/pending）、哈希链证书；时间线同时写入 `<dir>/timeline.json`。
- `correct --id P --start S --end E [--pending]` 气象更正可用窗，输出受影响任务。
- `drop --id P --reason weather|conflict|quota [--pending]` 丢弃过顶并归因；
  `--pending`（未决气象）计入 `pending`，不判失败。
- `undo [--steps N | --to SEQ]` 多层撤销，目标必须是 pass 边界
  （`pass_add`/`schedule` 条目之后或 0）。
- `verify` 校验哈希链；拒绝半截/篡改的尾部并截断恢复（退出码 1），恢复后退出码 0。

## 调度语义

- 过顶从（更正后）窗口起点传输 `txLen = ceil(bytes/rate)` 秒，
  `bytes = min(rate*窗口长, 星上剩余)`。
- 切换建立时间：相邻传输需间隔 `setup` 秒。
- 选择：DP 精确最大化总有效字节；并列时先比亏欠满足字节，再按
  （任务ID, 开始秒） 字典序。亏欠 = `max(0, min保障 - 已传)`。
- 配额：按公平序（亏欠降序、任务ID、开始秒）分配任务日配额。
- 抢占：已确认（locked）段不可抢占，其余过顶须避开锁定段（含 setup）。

## 退出码

- `0` 成功；`1` 日志损坏（verify 已恢复）；`2` 用法错误；
- `9` 负仰角 / 码速率超链路 / 撤销已确认字节。

## 测试

```
node --test test/*.test.js
```
