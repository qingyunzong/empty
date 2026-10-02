# RESULTS

运行环境：Node.js 22，仅标准库，离线单机。以下为真实运行输出。

## node --test

```
$ node --test
ok 1 - test/cli.test.js
ok 2 - test/ledger.test.js
# tests 2
# pass 2
# fail 0
```

子测试明细（9 项全部通过）：

```
test/ledger.test.js
ok 1 - child rule overrides parent rule                                   # 验收1：子级覆盖父级
ok 2 - insufficient balance splits across multiple levels                 # 验收2：余额不足多级分摊
ok 3 - reverse fails with E_RESTORE when an intermediate balance changed  # 验收3：中间层余额变化 -> E_RESTORE
ok 4 - comparePlans: covered desc, then shallow depth, then node id       # 并列规则：层级浅 -> id 字典序
ok 5 - small graph: enumerate all paths and cross-check against brute force  # 验收4：小图枚举所有路径对照

test/cli.test.js
ok 1 - CLI processes a case file and writes results
ok 2 - CLI exits 1 with stderr on invalid JSON
ok 3 - CLI exits 1 with stderr on unknown node
ok 4 - CLI exits 1 without arguments
```

## CLI 实跑

```
$ node cli.js examples/case.jsonl examples/result.json   # 退出码 0
```

逐步结果（每步承担额 / 恢复结果 / 失败码）：

```
chargeback cb1 OK start=t1 t1:50 -> s1:100
chargeback cb2 OK start=t2 t2:80 -> s1:40
reverse rv1 E_RESTORE drift=[{"node":"s1","expected":100,"actual":60}]
reverse rv2 OK s1:40 -> t2:80
reverse rv3 OK s1:100 -> t1:50
route rt1 OK m1:40
chargeback cb3 OK start=t1 t1:40
balances {"m1":1000,"s1":200,"t1":10,"t2":80,"s2":0,"t3":30}
audit entries 7
```

说明：

- `cb1`/`cb2` 从终端向上分摊（t→s），记录每步承担额。
- `rv1` 撤销 `cb1` 时中间层 `s1` 余额已被 `cb2` 改动（60 ≠ 100）→ `E_RESTORE`，余额不变，审计保留该失败尝试。
- `rv2` 先撤销 `cb2`（按原路径逆序 s1→t2 回补），随后 `rv3` 撤销 `cb1` 成功。
- `rt1`（route 40）：所有路径同额覆盖，按层级最浅选中 `m1`。
- `cb3`（candidates t1/t2/t3，同额同深度）：按节点 id 字典序选中 `t1`。

完整输出见 `examples/result.json`（含 `results` / `balances` / `audit`）。

## 错误路径

```
$ node cli.js bad.jsonl out.json    # bad.jsonl 第 2 行为非法 JSON
E_INPUT: line 2: invalid JSON       # stderr，退出码 1
```
