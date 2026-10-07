# RESULTS — 真实运行输出

环境：Node.js v22.22.1，仅标准库，单机离线。运行时间：2026-10-07。

## `node --test`（5 个测试文件，24 个用例，全部通过）

```
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

分文件明细（`node test/<file>`）：

| 文件 | 用例 | 通过 | 失败 | 覆盖验收点 |
| --- | --- | --- | --- | --- |
| test/static.test.js | 5 | 5 | 0 | 验收1：三层嵌套、内层放大上限 E_SCOPE；E_TYPE；只读 shadowing |
| test/engine.test.js | 9 | 9 | 0 | 验收2：冻结等于可用、到期 00:00、负解冻；验收3：同时刻 tie-break |
| test/fuzz.test.js | 5 | 5 | 0 | 验收4：5 个种子随机事件流 vs 独立枚举参考，三额一致 |
| test/parser.test.js | 3 | 3 | 0 | 词法模式、Pratt 优先级、when/unless |
| test/cli.test.js | 2 | 2 | 0 | apply/replay 端到端、编译期 E_SCOPE 退出码 |

## `quota apply examples/script.qta examples/events.jsonl --out state.json`

```
applied 8 events: 6 ok, 2 rejected
bucket working_capital: available=970000 frozen=0 used=30000 (limit=1000000)
bucket revolver: available=500000 frozen=0 used=0 (limit=500000)
rejected F-003 [E_CAP] freeze 60000 would raise scope 'HQ/REGION/TEAM' frozen to 180000 > cap 150000
rejected F-004 [E_NOTE] note 'bad note!' rejected by whitelist /^[A-Z0-9-]{3,32}$/
```

手工核对：1,000,000 − 120,000(F-001) − 100,000(F-002) + 20,000(U-001)
+ 100,000(F-002 于 2026-12-01 业务日到期) + 70,000(F-001 未用部分于
2027-01-01 业务日到期) = 970,000；used = 30,000(D-001 扣减)；
available + frozen + used = 1,000,000，守恒成立。

## `quota replay state.json`

```
bucket working_capital: available=970000 frozen=0 used=30000 (limit=1000000)
bucket revolver: available=500000 frozen=0 used=0 (limit=500000)
REPLAY OK: state matches recorded final state
```

退出码：apply=0，replay=0（不一致时为 2，编译失败为 1）。
