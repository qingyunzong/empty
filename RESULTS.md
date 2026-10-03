# RESULTS

测试环境：Node.js v22.22.1，仅标准库，`node --test`。以下为真实运行输出。

## 总览（`npm test`，即 `node --test test/*.test.js`）

```
ok 1 - test/dsl.test.js
ok 2 - test/fuzz.test.js
ok 3 - test/vm.test.js
# tests 3
# pass 3
# fail 0
# duration_ms 4430.206263
```

## 验收点明细

### 验收 1：更正链 A1 -> A2 -> 撤销 A2 回到 A1

```
ok 1 - acceptance 1: amend chain A1 -> A2 -> revoke A2 restores A1
```

`trade A v1 (buy 100 @150)` → `amend A v2 (buy 120)` → `revoke A v2`：
撤销后有效版本回到 v1，`frozenCash` 从 18001.5 回到 15001.5，
版本图保留 `[1, 2]`，tombstone 记录 `[2]`（历史不被改写）。

### 验收 2：越界卖空冻结报 E_NEG 且状态不变

```
ok 2 - acceptance 2: oversell freeze fails with E_NEG and leaves state unchanged
ok 3 - amend that turns position negative is rejected with E_NEG
```

持有 50 股时卖 60 → `E_NEG`，失败前后 `vm.snapshot()` 完全一致，
`lastSeq` 不前进；随后可用修正后的同 seq 事件继续。更正导致的
负持仓（buy 50 / sell 40 后 amend buy 为 30）同样被拒绝。

### 验收 3：同一 seq 重放幂等

```
ok 4 - acceptance 3: same-seq replay is idempotent
```

相同 seq + 相同内容哈希 → `skipped: true`，状态逐字段相等；
同 seq 不同内容 → `E_SEQ`。

### 验收 4：随机 200 事件 vs 独立折叠参考，逐前缀对照

```
ok 1 - acceptance 4: random 200 events (seed 1) match independent fold at every prefix
ok 2 - acceptance 4: random 200 events (seed 7) match independent fold at every prefix
ok 3 - acceptance 4: random 200 events (seed 42) match independent fold at every prefix
ok 4 - acceptance 4: random 200 events (seed 2024) match independent fold at every prefix
```

每个种子生成 200 个事件（新成交 / amend（含同号并发、落后版本的未决更正）/
revoke / 幂等重放），VM 逐事件快照与 `test/helpers/reference.js`
（不使用字节码与 VM、每个前缀从零朴素折叠的独立实现）共 200 个前缀
逐一 `deepStrictEqual`，4 个种子全部一致。

## 其余用例

```
ok 5 - E_SEQ: gaps and out-of-order seq rejected
ok 6 - E_VERSION: unknown trade, duplicate trade, cross-date scope
ok 7 - pending correction is not a failure: stale/concurrent versions are kept
ok 8 - concurrent same-version records tie-break by hash
ok 9 - fold --at prefix: state at any seq prefix
ok 1..6 - dsl.test.js（词法/Pratt 优先级/E_SIGN 类型检查/字节码编译）
```

## CLI 冒烟

```
$ node bin/escrow.js fold examples/ticks.jsonl --at 3   # 正常输出前缀状态，seq=3
$ node bin/escrow.js fold /tmp/bad.jsonl                # 越界卖空
error E_NEG at seq 2: oversell on 2024-01-15|US0378331005: net shares -89
exit=1
```
