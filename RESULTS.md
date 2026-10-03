# RESULTS — 验收记录

环境：Node.js v22.22.1，仅标准库，单机离线。以下命令均为真实执行，输出为实际结果。
测试进程内模拟 kill（沙箱禁止 node 派生子进程）；CLI 的真实 `je run` / `je recover`
命令经 bash 直接执行验证，输出如下。

## 0. 测试套件

```
$ node --test
ok 1 - test/balance.test.js
ok 2 - test/crash.test.js
ok 3 - test/normal.test.js
ok 4 - test/period.test.js
ok 5 - test/random.test.js
ok 6 - test/recover.test.js
1..6
# tests 6
# pass 6
# fail 0
```

## 1. 正常三批次（test/normal.test.js + CLI）

```
$ node bin/je.js run examples/batch.je examples/events.json --db /tmp/je-results/db-ref
POSTED SALE#1
POSTED SALE#2
POSTED SALE#3
OK run: 3 batch(es), 6 posting(s), db=/tmp/je-results/db-ref
```

index.json 余额：`1001=12222, 2001=-12100, FEE=-122`（分），三批次均 POSTED。
WAL 记录序列严格为 `(BEGIN_BATCH POST POST END_BATCH) × 3`，无其他写点。

## 2. 指定崩溃点 kill 后 recover 与无崩溃参考一致（test/crash.test.js + CLI）

```
$ JE_CRASH_AT=post:6 node bin/je.js run examples/batch.je examples/events.json --db /tmp/je-results/db-crash
E_CRASH: simulated crash after POST seq=6 written to disk, before index update
== exit 75 ==

$ node bin/je.js recover --db /tmp/je-results/db-crash
REPLAYED posting seq=6
BATCH SALE#1 POSTED
BATCH SALE#2 POSTED
BATCH SALE#3 IN_FLIGHT
OK recover: replayed 1 posting(s), lastSeq=6
```

恢复后 `balances` 与 `lastSeq` 和无崩溃参考完全一致（`true`），
`postings.jsonl` 逐字节相同（`cmp` 通过）。被 kill 的 SALE#3 保持
IN_FLIGHT（未决，不等同失败，也不补记为 POSTED）。

## 3. 重复 recover 幂等（test/recover.test.js + CLI）

```
$ node bin/je.js recover --db /tmp/je-results/db-crash   # 第二次
BATCH SALE#1 POSTED
BATCH SALE#2 POSTED
BATCH SALE#3 IN_FLIGHT
OK recover: replayed 0 posting(s), lastSeq=6
```

测试中对 recover 前后的 `wal.log` / `postings.jsonl` / `index.json`
做快照比对，连续三次 recover 后文件完全一致。E_REPLAY 由两个腐败用例覆盖
（posting 无 WAL 记录、posting 与 WAL 内容不符）。

## 4. 关闭期间入账报错（test/period.test.js + CLI）

```
$ node bin/je.js run /tmp/je-results/closed.je examples/events.json --db /tmp/je-results/db-closed
E_PERIOD: batch 'SALE': period '2024-12' is closed
== exit 1 ==
```

未声明期间同样报 E_PERIOD（`unknown period`）。

## 5. 随机 100 事件与独立余额表对照（test/random.test.js）

确定性 PRNG（mulberry32, seed=20251004）生成 100 个 sale/refund 事件
（金额 0.01–1000.00 元）。测试内独立计算余额表（同一舍入规则：元 →
1e-6 单位 → 分），与 `index.json` 余额 `deepEqual` 一致；并校验：
100 个批次全部 POSTED、每条 posting 借贷相等、索引余额等于 postings
重放和（不双记不漏记）。

## 补充：E_BALANCE / E_SCOPE（test/balance.test.js）

- 编译期：无法静态证明借=贷且无 `balance` 断言 → E_BALANCE。
- 运行时：`balance dr == cr;` 断言在事件数据不平衡时 → E_BALANCE。
- 模板科目在 `use` 它的批次之外被引用 → E_SCOPE（禁止模板外泄漏）。
