# RESULTS

测试环境：Node.js v22.22.1，仅标准库，无网络。所有输出为真实运行结果。

## `node --test`

```
✔ test/acceptance.test.js
✔ test/unit.test.js
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

共 19 个断言测试（13 个单元测试 + 6 个验收/CLI 测试），全部通过：

```
ok 1 - acceptance 1: amend chain A1 -> A2 -> cancel A2 falls back to A1
ok 2 - acceptance 2: oversell freeze raises E_NEG and leaves state unchanged
ok 3 - acceptance 3: replaying the same seq is idempotent
ok 4 - acceptance 4: 200 random events, VM matches independent fold at every prefix
ok 5 - cli: fold with --at reproduces every prefix state
ok 6 - cli: E_NEG exits 1 with JSON error on stderr
```

## 验收对照

1. **更正链 A1→A2→撤销 A2 回到 A1**：`cancel A v2` 只追加 tombstone，有效版本
   回落 v1，台账与只有 A1 时逐字段相等（`acceptance 1`）。
2. **越界卖空 E_NEG 且状态不变**：持仓 100、已冻结 60，再卖 50 → `E_NEG`，
   拒绝前后 `vm.state()` 深度相等；被拒事件不消耗 seq（`acceptance 2`）。
3. **同一 seq 重放幂等**：相同内容重放返回 `{ok:true, noop:true}`，状态不变；
   同 seq 不同内容报 `E_SEQ`（`acceptance 3`）。
4. **随机 200 事件差分对照**：VM（增量 delta + 字节码）与独立参考折叠器
   `reference/fold.js`（每事件全量重算 + AST 树遍历求值）逐前缀 `deepEqual`，
   且每个被拒事件的错误码一致（`acceptance 4`）。

## 多种子扫描（验收 4 的加强版，脚本见下）

```
seed 1: OK (200 events, 64 rejected)
seed 42: OK (200 events, 78 rejected)
seed 777: OK (200 events, 55 rejected)
seed 20261003: OK (200 events, 53 rejected)
seed 999983: OK (200 events, 69 rejected)
```

随机流覆盖：跨日作用域违规（E_VERSION）、未知成交更正（E_VERSION）、超持仓卖空
（E_NEG）、未决 tombstone（先 cancel 后 amend 同版本）、同号并发版本哈希
tie-break、精确重放（幂等 no-op）。

## CLI 实跑

```console
$ node bin/escrow.js fold examples/ticks.jsonl --at 6
{"lastSeq":6,"ledger":{"2026-10-03|CNE000000001":{"heldQty":"100000","frozenQty":"200",
"heldCash":"10000000","frozenCash":"15790"},...},"applied":6}
# seq=6 时 A 的 v2 仍有效：frozenCash = 1500*10.5 + 40 = 15790

$ node bin/escrow.js fold examples/ticks.jsonl
# 全量折叠后 A 的 v2 已被 tombstone：frozenCash 回到 1000*10 + 30 = 10030
# 文件末尾 seq=3 的精确重放为幂等 no-op（applied=9，共 10 行）

$ node bin/escrow.js fold /tmp/oversell.jsonl
{"error":"E_NEG","message":"oversell: frozen qty 50 exceeds held 10 for CNE000000001 on 2026-10-03","seq":2}
# 退出码 1
```

复现命令：`node --test`；多种子扫描为临时脚本（生成器同
`test/acceptance.test.js` 中的 `generateEvents`，对每个前缀比较
`JSON.stringify(vm.state()) === JSON.stringify(ref.state())`）。
