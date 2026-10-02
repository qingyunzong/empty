# settlement-rollback

结算快照与层级回滚（Node.js 22，仅标准库，单机离线，无第三方依赖）。

## 模型

- **批次树**：`openBatch(id, parentId)` 建立层级，子批次依赖父批次；父批次已回滚时
  禁止挂载子批次或过账（`E_DEPEND`）。
- **savepoint**：`createSavepoint(name, { batchId, atSeq })` 在批次上建立恢复点，
  捕获 `atSeq` 之前的快照并记录完整性哈希。savepoint 必须立在日边界上：
  切开同一日的 `atSeq` 或越界 `atSeq` 报 `E_BOUNDARY`，过账日期回退同样报
  `E_BOUNDARY`。因此跨日边界的 savepoint 天然不含下一日首笔。
- **回滚**：`planRollback` 只撤销目标批次 savepoint 之后的分录及其后代批次；
  未结算分录直接作废，**已出账（settled）分录必须先生成冲正**——冲正分录挂在
  无父级的孤儿批次 `__orphan__:<savepoint>` 上（孤儿冲正清单），否则报
  `E_ORPHAN`；执行后校验任何在账分录不得挂在已回滚批次上（禁止悬空恢复）。
- **更正保留**：快照之后的更正若覆盖快照内存活分录，回滚保留更正后的值，
  恢复点不得复活被后续更正覆盖的交易。
- **输出**：回滚计划（撤销清单 / 孤儿冲正清单 / 保留更正）、影响区间
  （seq 与 day 范围、清除批次）、执行前后状态哈希（SHA-256，规范化序列化）。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_SNAP` | savepoint 缺失 / 完整性哈希不符 / 已消费 / 计划已过期 / 恢复快照校验失败 |
| `E_DEPEND` | 批次依赖违规：父批次缺失或已回滚、重复批次、目标批次不可用 |
| `E_ORPHAN` | 已出账后代未先生成冲正，或恢复将产生悬空分录 |
| `E_BOUNDARY` | savepoint 切开同一日、atSeq 越界、过账日期回退 |

## 用法

```bash
npm test          # node --test
npm run demo      # 三级批次回滚演示
npm run check     # 100 个随机小账期与参考模型对照
```

库接口（`src/index.js`）：

```js
const { Ledger, planRollback, executeRollback } = require('./src');
const ledger = new Ledger();
ledger.openBatch('G');
ledger.post('G', { account: 'cash', amount: 1000, day: 1 });
ledger.createSavepoint('sp-eod1', { batchId: 'G' });
// ... 子批次过账 / 结算 / 更正 ...
const plan = planRollback(ledger, 'sp-eod1');   // 回滚计划 + 影响区间 + 执行前哈希
const { preHash, postHash } = executeRollback(ledger, plan);
```

## 真实输出

`node bin/cli.js demo`（祖父 G / 父 P / 子 C 未结算，S 已出账，e1 在快照后被更正为 1200）：

```
== 回滚计划 savepoint=sp-eod1 target=G ==
影响区间: seq [3..6] day [2..2] 清除批次: [C, P, S]
撤销清单(未结算):
  - e3 batch=P cash 200 day=2
  - e4 batch=C fee 50 day=2
孤儿冲正清单(已出账须先冲正):
  - e5 batch=S cash 300 day=2 -> 待生成冲正
  - e6 batch=S rev -300 day=2 -> 待生成冲正
保留更正(禁止复活旧值):
  - e7 覆盖 e1 cash -> 1200
执行前哈希: 687150831fe5dcbc09e600fc3585a24b936b42634661768f633c6f1a0c24a115
== 执行结果 ==
孤儿冲正批次: __orphan__:sp-eod1
执行前哈希: 687150831fe5dcbc09e600fc3585a24b936b42634661768f633c6f1a0c24a115
执行后哈希: 61f6c406d357f2cc03a018dbe32ba548111b0c1c2fb2a13d4c21792695bbfc31
孤儿冲正清单(已生成):
  - e5 batch=S cash 300 -> 冲正 e8 (-300)
  - e6 batch=S rev -300 -> 冲正 e9 (300)
余额: {"cash":1200,"rev":-1000}
逐笔重放对照: {"cash":1200,"rev":-1000}
快照推导对照: {"cash":1200,"rev":-1000}
一致性: OK
```

`node bin/cli.js check --seeds 8`（随机小账期 vs 逐笔重放 + 快照推导两个参考模型）：

```
seed=1 undo=1 reversals=0 pre=e6472b7e742e7e07… post=cb82d3ee4eb3415a… OK
seed=2 undo=2 reversals=0 pre=8fef32d77b3bff88… post=d972e429ac05572e… OK
seed=3 undo=6 reversals=0 pre=08c73e175160ae12… post=e70455efa87a0ef2… OK
seed=4 undo=2 reversals=0 pre=5f20eeaabc668d36… post=84a65ac804006fda… OK
seed=5 undo=3 reversals=1 pre=9e67e1d4b51866d5… post=10e2bfddb123337d… OK
seed=6 undo=4 reversals=0 pre=d4b50dd4bea11d6c… post=7ddf4470ef2ea84c… OK
seed=7 undo=4 reversals=0 pre=05e5accf8ca1237b… post=09c6cb4cc4afa1a4… OK
seed=8 undo=2 reversals=0 pre=6d0b0a5700256388… post=e749c677cb872fc5… OK
对照完成: 8/8 通过
```

`node --test`：

```
TAP version 13
# Subtest: test/rollback.test.js
ok 1 - test/rollback.test.js
  ---
  duration_ms: 1519.706939
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1627.19635
```

## 目录

- `src/ledger.js` — 追加式账本、批次树、更正链、savepoint 与日边界校验
- `src/rollback.js` — 回滚计划 / 执行：孤儿冲正、悬空检查、快照恢复校验
- `src/reference.js` — 参考模型：逐笔重放 + 快照推导（测试对照用）
- `src/random.js` — 确定性随机小账期生成器（mulberry32）
- `src/errors.js` / `src/hash.js` — 错误码与规范化哈希
- `bin/cli.js` — CLI：`demo` / `check [--seeds N]`
- `test/rollback.test.js` — 验收 1–4 及四类错误码测试
