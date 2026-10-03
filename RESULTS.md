# RESULTS — 真实运行记录

运行环境：Node.js v22.22.1，单机离线，仅标准库。日期：2026-10-03。

## `node --test`（全部测试）

```
1..7
# tests 7
# suites 0
# pass 7
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 14329.25014
```

7 个测试文件全部通过，共 37 个子测试（逐文件统计，`pass/fail`）：

| 文件 | 子测试 | 结果 | 覆盖验收点 |
| --- | --- | --- | --- |
| `test/dsl.test.js` | 20 pass / 0 fail | ✅ | 验收 1：内层放宽无 override 必失败（E_OVERRIDE）；带 override 放宽同样失败；收紧 override 留痕；E_TYPE/E_CIDR/E_VERSION 各错误码 |
| `test/vm.test.js` | 9 pass / 0 fail | ✅ | 验收 2：并列最严规则全部列出且稳定排序（含源码乱序对照）；DENY>REVIEW>ALLOW；未决复核不视为通过；作用域匹配；收紧阈值生效 |
| `test/replay.test.js` | 3 pass / 0 fail | ✅ | 验收 3：热更新 V2 后旧事件重放结果与更新前 `deepEqual`，仍按 v1 判定；新版本事件按 v2 |
| `test/property.test.js` | 1 pass / 0 fail | ✅ | 验收 4：200 个随机种子 × 5 事件 = 1000 组随机规则/事件，字节码 VM 与独立决策树参考解释器（`test/helpers/reference.js`）的 decision/strictest/hits 完全一致 |
| `test/cli.test.js` | 4 pass / 0 fail | ✅ | `risk eval`/`--explain`/`check` 端到端；编译错误退出码 2 且 stderr 以 `E_OVERRIDE:` 开头 |

## `node bin/risk.js check examples/rules.rsk`

```
version v1: since=2024-01-01T00:00:00.000Z rules=6
  override global/channel("alipay"): threshold max_amount money 10000.00 -> 5000.00 (tightened)
  override global/channel("alipay")/merchant("MCH000001"): threshold max_amount money 5000.00 -> 2000.00 (tightened)
version v2: since=2024-06-01T00:00:00.000Z rules=3
  override global/channel("alipay"): threshold max_amount money 8000.00 -> 3000.00 (tightened)
OK
```

## `node bin/risk.js eval examples/rules.rsk examples/events.jsonl`

```
{"id":"e1","time":"2024-03-01T10:00:00Z","version":"v1","decision":"DENY","rules":["global/channel(\"alipay\")/a_amount","global/channel(\"alipay\")/merchant(\"MCH000001\")/m_amount","global/g_amount"]}
{"id":"e2","time":"2024-03-01T11:00:00Z","version":"v1","decision":"REVIEW","rules":["global/channel(\"alipay\")/a_review_band"]}
{"id":"e3","time":"2024-03-01T12:00:00Z","version":"v1","decision":"REVIEW","rules":["global/g_count"]}
{"id":"e4","time":"2024-07-01T09:00:00Z","version":"v2","decision":"DENY","rules":["global/channel(\"alipay\")/a_amount"]}
```

要点：e1 同时命中 3 条并列最严 DENY 规则并全部按稳定字典序列出；e2/e3 为
REVIEW（未决复核不视为通过）；e4 时间为 2024-07，路由到热更新后的 v2 版本。

## `--explain` 节选（e1）

```
event=e1 time=2024-03-01T10:00:00.000Z version=v1 decision=DENY
strictest:
  DENY global/channel("alipay")/a_amount
  DENY global/channel("alipay")/merchant("MCH000001")/m_amount
  DENY global/g_amount
hits:
  DENY global/channel("alipay")/a_amount
  DENY global/channel("alipay")/merchant("MCH000001")/m_amount
  DENY global/g_amount
overrides:
  global/channel("alipay"): threshold max_amount money 10000.00 -> 5000.00 (tightened)
  global/channel("alipay")/merchant("MCH000001"): threshold max_amount money 5000.00 -> 2000.00 (tightened)
```

## 备注

- 本沙箱环境会吞掉子进程管道 stdout，CLI 测试通过临时文件重定向捕获子进程输出
  （见 `test/cli.test.js` 的 `run()`），不影响库与 CLI 本身行为。
