# RESULTS — 真实测试输出

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线。
所有输出均为真实运行结果（2026-10-04）。

## 1. 完整测试套件 `node --test test/*.test.js`

```
TAP version 13
# Subtest: test/cli.test.js
ok 1 - test/cli.test.js
  ---
  duration_ms: 14927.420898
  type: 'test'
  ...
# Subtest: test/enumeration.test.js
ok 2 - test/enumeration.test.js
  ---
  duration_ms: 25919.39141
  type: 'test'
  ...
# Subtest: test/ledger.test.js
ok 3 - test/ledger.test.js
  ---
  duration_ms: 2203.597601
  type: 'test'
  ...
# Subtest: test/recovery.test.js
ok 4 - test/recovery.test.js
  ---
  duration_ms: 1163.695979
  type: 'test'
  ...
# Subtest: test/scale.test.js
ok 5 - test/scale.test.js
  ---
  duration_ms: 15387.377645
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 26332.578732
```

## 2. 验收对照

### 验收 1：3 万条含 5% 更正，view 与 n≤15 枚举应用序对照

`node test/scale.test.js`（30031 条 entry，1262 条更正 + 79 条 tombstone，
28 个冲突证书；全部 2000 个账户的 view 与独立 fold  applicator 在随机
应用序下逐一比对，另抽 10 个账户做 proof 验证）：

```
  scale: entries=30031 posts=28659 corrections=1262 tombstones=79 conflicts=28
  timing: gen=5376ms verify=2487ms view=727ms accounts=2000 proofs=10
ok 1 - 30k entries with 5% corrections: verify passes, view matches reference applicator
# pass 1
```

`node test/enumeration.test.js`（300 个 n≤15 的随机账户日志，共 85317 个
合法应用序逐一与库 view 对照）：

```
  enumeration cross-check: 300 random logs, 85317 application orders, all match
ok 1 - view matches enumerated application orders for n <= 15
# pass 1
```

### 验收 2：篡改中间字节 → verify 退出码 4 并报告 offset

真实运行（篡改文件第 776 字节，verify 定位到包含该字节的 entry：
seq=2，行起始 offset=561，退出码 4，日志未被截断）：

```
tampered byte at file offset 776 of 1553

$ node cli.js verify --file $L ; echo exit=$?
{"ok":false,"seq":2,"offset":561,"reason":"hash-mismatch"}
exit=4

$ ls -l $L (log size unchanged: verification never truncates)
1553 bytes
```

### 验收 3：崩溃在写 index 后未写 log → 恢复丢弃悬空索引

`node --test test/recovery.test.js`（另覆盖反向崩溃：log 已写、index
未写时重建索引尾部）：

```
ok 1 - test/recovery.test.js
# tests 1
# pass 1
# fail 0
```

### 验收 4：proof 可被独立 verify-proof 子命令重算

真实运行（proof 写出 3 条 alice 相关 entry + 哈希链路径 + 更正祖先，
verify-proof 独立重算通过；cli.test.js 另覆盖篡改 proof → 退出码 4）：

```
$ node cli.js proof --file $L --account alice --out $D/alice-proof.json
{"wrote":"/tmp/results-demo/alice-proof.json","account":"alice","entries":3}

$ node cli.js verify-proof --proof $D/alice-proof.json --file $L ; echo exit=$?
{"ok":true,"account":"alice","head":{"seq":4,"hash":"b67b2c37e436ba3c2afd62772750bcd48795e712827603557b640e84d6697a45"},"entries":3}
exit=0

$ node -e "…flip one byte at the middle of ledger.log…"
```

## 3. CLI 全流程实录（log → verify → view）

```
$ node cli.js log --file $L --account alice --amount 1000 --biz-key inv-1 --ts 1700000000000 --biz-time 1700000000000
{"seq":0,"hash":"4c4cd1fecbc9953d36e54805069c26061594a805b1309c28a109ab9a5897a5a4","prevHash":"0000000000000000000000000000000000000000000000000000000000000000"}
$ node cli.js log --file $L --account alice --amount 500 --biz-key inv-2 --ts 1700000001000 --biz-time 1700000000900
{"seq":1,"hash":"43cfef0a4bfa8fee936a513334001a22c7e5ff7e52cd1daf18f5ffa082adaeb7","prevHash":"4c4cd1fecbc9953d36e54805069c26061594a805b1309c28a109ab9a5897a5a4"}
$ node cli.js log --file $L --account bob --amount 250 --biz-key inv-3 --ts 1700000002000 --biz-time 1700000002000
{"seq":2,"hash":"56e5909f2810ff470bf18a38356b8b3bac881b4f483d18754aedf3ca9653836a","prevHash":"43cfef0a4bfa8fee936a513334001a22c7e5ff7e52cd1daf18f5ffa082adaeb7"}
$ node cli.js log --file $L --type correct --account alice --amount 1200 --supersedes <hash-of-entry-0> --ts 1700000003000 --biz-time 1700000000050
{"seq":3,"hash":"534a639161ab0663fc2c1d1f10547c9e4aeb74d14fd01fc1bfd0753ccb55168c","prevHash":"56e5909f2810ff470bf18a38356b8b3bac881b4f483d18754aedf3ca9653836a"}
$ node cli.js log --file $L --type tombstone --account bob --supersedes <hash-of-entry-2> --ts 1700000004000 --biz-time 1700000002100
{"seq":4,"hash":"b67b2c37e436ba3c2afd62772750bcd48795e712827603557b640e84d6697a45","prevHash":"534a639161ab0663fc2c1d1f10547c9e4aeb74d14fd01fc1bfd0753ccb55168c"}

$ node cli.js verify --file $L ; echo exit=$?
{"ok":true,"entries":5,"head":"b67b2c37e436ba3c2afd62772750bcd48795e712827603557b640e84d6697a45"}
exit=0

$ node cli.js view --file $L
{
  "accounts": {
    "alice": {
      "balance": 1700,
      "effective": [
        "534a639161ab0663fc2c1d1f10547c9e4aeb74d14fd01fc1bfd0753ccb55168c",
        "43cfef0a4bfa8fee936a513334001a22c7e5ff7e52cd1daf18f5ffa082adaeb7"
      ],
      "tombstoned": [],
      "superseded": [
        "4c4cd1fecbc9953d36e54805069c26061594a805b1309c28a109ab9a5897a5a4"
      ],
      "conflicts": []
    },
    "bob": {
      "balance": 0,
      "effective": [],
      "tombstoned": [
        "b67b2c37e436ba3c2afd62772750bcd48795e712827603557b640e84d6697a45"
      ],
      "superseded": [
        "56e5909f2810ff470bf18a38356b8b3bac881b4f483d18754aedf3ca9653836a"
      ],
      "conflicts": []
    }
  }
}
```
