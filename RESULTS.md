# RESULTS — 真实命令与结果

环境：Node.js v22.22.1，仅标准库，单机离线。日期：2026-10-03。

## 测试套件

命令：`node --test`

```
ok 1 - test/acceptance.test.js
ok 2 - test/dsl.test.js
ok 3 - test/helpers.js
ok 4 - test/random.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 3356.135767
```

逐文件子测试（共 17 个，全部通过）：

```
node test/acceptance.test.js
ok 1 - acceptance 1: three normal batches commit with correct balances
ok 2 - acceptance 2: kill at the defined crash point, recover matches the no-crash reference
ok 3 - acceptance 2b: crash between WAL write and post write is replayed too
ok 4 - acceptance 3: repeated recover is idempotent
ok 5 - acceptance 4: posting into a closed period fails with E_PERIOD
ok 6 - E_REPLAY: corrupt WAL record aborts recovery
ok 7 - E_REPLAY: post content mismatch between WAL and disk aborts recovery

node test/dsl.test.js
ok 1 - lexer recognizes account, debit/credit, period and batch tokens
ok 2 - pratt parser respects operator precedence in balance conditions
ok 3 - static check proves debit == credit symbolically (polynomial balance)
ok 4 - E_BALANCE: statically unbalanced template is rejected at compile time
ok 5 - E_BALANCE: explicit balance condition that does not hold is rejected
ok 6 - E_SCOPE: template parameters cannot leak across templates
ok 7 - E_TYPE: a parameter cannot be both an account and a value
ok 8 - E_PERIOD: batch binding an undeclared period is rejected at compile time
ok 9 - compiler emits bytecode for the vm

node test/random.test.js
ok 1 - acceptance 5: 100 random events match an independent balance sheet
```

注：沙箱禁止嵌套 spawn（EPERM），验收测试通过 `JE_CRASH_MODE=throw` 在进程内模拟 kill；
store 全部写盘均为同步调用，抛出点的磁盘状态与真实 kill 完全一致。真实 kill 路径
（`process.exit(97)`）另用真实子进程验证，见下「验收 2」。

## 验收 1：正常三批次

命令：`node cli.js run examples/batch.je examples/events.json --db /tmp/results-demo/db1`

```
batch B1 committed (2 event(s), period 2025-01)
batch B2 committed (1 event(s), period 2025-01)
batch B3 committed (1 event(s), period 2025-02)
balances:
{
  "2025-01": { "cash": 240, "ar": -40, "revenue": -190, "fees": -10 },
  "2025-02": { "cash": 30, "supplies": -30 }
}
```

每期借贷合计均为 0，三批次 COMMITTED。

## 验收 2：崩溃点 kill 后 recover 与无崩溃参考一致

崩溃点 = 第 4 条 POST 写盘后、索引更新前（共 4 条：B1×2、B2×1、B3×1）。

```
$ JE_CRASH_AFTER_POST=4 node cli.js run examples/batch.je examples/events.json --db /tmp/results-demo/db2
exit code: 97                       # 真实进程退出，模拟宕机

$ node cli.js run examples/batch.je examples/events.json --db /tmp/results-demo/db2
E_CRASH: database at '/tmp/results-demo/db2' was not shut down cleanly; run 'je recover ...' first
exit code: 1                        # 脏库拒绝直接重跑

$ node cli.js recover --db /tmp/results-demo/db2
recovery complete: replayed 1 action(s)
IN_FLIGHT batches (pending, NOT failed): B3

$ diff <(node cli.js balances --db /tmp/results-demo/db1) \
       <(node cli.js balances --db /tmp/results-demo/db2)
IDENTICAL                           # 与无崩溃参考完全一致：不双记、不漏记
```

恢复后 B3 保持 `IN_FLIGHT`（未决，非失败），B1/B2 为 `COMMITTED`。

## 验收 3：重复 recover 幂等

```
$ node cli.js recover --db /tmp/results-demo/db2
recovery complete: replayed 0 action(s)
IN_FLIGHT batches (pending, NOT failed): B3
$ node cli.js recover --db /tmp/results-demo/db2
recovery complete: replayed 0 action(s)
IN_FLIGHT batches (pending, NOT failed): B3
```

测试另断言第二次 recover 后 `index.json` 与 `posts.jsonl` 字节级不变。

## 验收 4：关闭期间入账报错

```
$ node cli.js close-period 2025-01 --db /tmp/results-demo/db3
period 2025-01 closed
$ node cli.js run examples/batch.je examples/events.json --db /tmp/results-demo/db3
E_PERIOD: period '2025-01' is closed
exit code: 1
```

编译期绑定未声明期间同样报 `E_PERIOD`（见 dsl 测试 8）。

## 验收 5：随机 100 事件对照独立余额表

`test/random.test.js`：mulberry32(20251003) 生成 10 批 × 10 事件（transfer/sale 混合、
随机科目与金额），CLI 跑完后 `index.json` 余额与测试内独立累加的余额表 `deepEqual`，
且全部科目余额代数和为 0。结果：`ok 1 - acceptance 5`。

## 其他错误路径实测

```
$ node cli.js run bad.je examples/events.json --db db4     # debit $x / credit $x+1
E_BALANCE: template 'bad' is not provably balanced; residual = -1   (exit 1)

$ echo '{corrupt' >> wal.log && node cli.js recover --db db5
E_REPLAY: corrupt WAL record at line 10 of .../wal.log              (exit 1)
```
