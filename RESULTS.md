# RESULTS — 真实运行记录

环境：Node.js v22.22.1（`node --version` 实测），Linux，离线，仅标准库。
日期：2026-10-03。

## 全部测试：`node --test`

```
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4312.669003
```

6 个测试文件全部通过，共 22 个子测试（逐文件 `node <file>` 实测）：

| 文件 | 子测试 | 结果 | 覆盖验收点 |
|---|---|---|---|
| `test/freeze.test.js` | 5/5 通过 | ✅ | 验收 1：重叠冻结合并、相邻合并、解冻切割（中间劈开/左右截断/整体清除）、无交集解冻 `E_RANGE`、非法区间 `E_RANGE` |
| `test/limits.test.js` | 5/5 通过 | ✅ | 验收 2：分类限额失败但总限额足够（`E_LIMIT`，`debitedTotal` 不变）；冻结阻断报 `E_RANGE`；超总限额 `E_LIMIT`；`E_DUP`；失败请求写审计链 |
| `test/concurrency.test.js` | 3/3 通过 | ✅ | 验收 3：同刻两笔各 60、总额 100，按 id 字典序 `a` 成功、`b` 失败（与文件顺序无关）；`(ts,id)` 全局排序；同刻同 id 后者 `E_DUP` |
| `test/random.test.js` | 5/5 通过 | ✅ | 验收 4：5 个随机种子 × 100 步（总额 50、分类 x:20/y:30，含同刻、重复 id、随机冻结/解冻/扣款），每步与按位暴力模型（`test/helpers/brute.js`）对照 `ok/reason/available/frozen`，最终状态一致 |
| `test/cli.test.js` | 4/4 通过 | ✅ | CLI 全成功退出 0；有失败退出 1 + stderr 写 `E_*` 详情且报告照常写出；缺配置行 / 坏 JSON → `E_RANGE` + stderr + 退出码 1 |
| `test/helpers/brute.js` | （被 random 测试引用的参照模型，非测试） | — | — |

## CLI 实测：`node cli.js examples/ops.jsonl report.json`

退出码 **1**（存在失败请求），stderr：

```
E_LIMIT: id=d2 op=debit ts=5 category limit "travel" exceeded
E_LIMIT: id=a op=debit ts=6 category limit "food" exceeded
E_LIMIT: id=b op=debit ts=6 category limit "food" exceeded
```

stdout：`steps=7 failed=3 available=550`

report.json 最终状态（实测）：

```json
{"available":550,"frozen":[[100,150],[250,400]],"frozenTotal":200,"debitedTotal":250,"debitedByScope":{"travel":250}}
```

逐步结果：`f1:ok f2:ok u1:ok d1:ok d2:E_LIMIT a:E_LIMIT b:E_LIMIT`；
审计链完整性校验通过（每条 `prevHash` 链接前一条 `hash`，首条为 64 个 `0`）。

## 复现

```sh
node --test
node cli.js examples/ops.jsonl report.json
```
