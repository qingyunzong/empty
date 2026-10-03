# device-window-stats

单机离线设备开停机窗口统计：库 + CLI，仅用 Node.js 22 标准库。

## 语义

- 事件：`{id, device, ts, state}`，`state` 为 `up`/`down`，`ts` 为秒级时间戳。
- 首事件之前状态为 `null`：未知区间既不计 uptime 也不计 downtime。
- 固定 15 分钟（900s）对齐窗口，输出 `uptime`/`downtime`/`unknown`，三者之和恒为 900；
  纯未知窗口的 `uptime`/`downtime` 为 `null`。
- 事件按水位线增量到达；迟到事件（`ts < watermark`）按键（id）插入后，
  受影响的已发布窗口被撤回（RETRACT）并以递增版本发布更正（CORRECT），不重复计数。

## 存储与故障语义

- `events.log`：仅追加日志，每行一个批次，是唯一的提交点。
- `state.json`：物化索引（已发布窗口及版本）。
- `--fail-after-append`：日志 append（含 fsync）后、索引更新前崩溃，退出码 2；
  重启后任意命令重放日志恢复，并对陈旧索引发布更正。
- `--fail-before-append`：append 前崩溃，退出码 3，该批完全无影响。

## CLI

```sh
node cli.js append --dir D --event '{"id":"e1","device":"A","ts":2000,"state":"up"}' \
    [--fail-before-append | --fail-after-append]
node cli.js query  --dir D --device A --from 0 --to 3600   # JSONL，每行一个窗口
node cli.js compact --dir D                                # 去重排序后原子重写日志
```

## 测试

```sh
node --test
```

- `test/aggregator.test.js`：增量聚合与参考算法（独立排序 + 逐秒扫描全部窗口）随机对拍。
- `test/scenarios.test.js`：三个验收场景，真实 stdout/stderr/退出码写入 `result.txt`。
