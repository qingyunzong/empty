# 测试结果(真实运行输出)

- 日期: 2026-10-03 14:12:59 CST
- 运行时: v22.22.1(仅标准库,node:test)
- 命令: `node --test`

## 汇总

```
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## 用例明细

```
ok 1 - revoke changes the as-of view before vs after
ok 2 - revoking a revoke restores visibility (cascade)
ok 3 - revoke cycles raise E_REVOKE_CYCLE
ok 4 - random op sequences (n<=8): every asOf matches brute-force replay
ok 5 - CLI: node cli.js log.jsonl --as-of 3 prints view and hash
ok 6 - CLI: asOf commands inside the JSONL drive output when no --as-of flag
ok 7 - CLI: revoke cycle exits 1 with E_REVOKE_CYCLE on stderr
ok 8 - CLI: malformed JSONL exits 1 with E_PARSE on stderr
ok 9 - immutability: committed entries cannot be mutated
```

## 验收对照

1. 撤销后 asOf 前后不同 → 用例 1(视图与 hash 均不同)。
2. 撤销的撤销恢复可见 → 用例 2(含三级级联:恢复后再次被隐藏)。
3. 撤销环报 E_REVOKE_CYCLE → 用例 3(自环/二元环/三元环)+ 用例 7(CLI 退出码 1)。
4. n<=8 随机操作枚举所有 asOf 与参考重放对照 → 用例 4(300 组随机序列,
   每组枚举 asOf=0..n,与 2^k 暴力一致性 oracle 对照可见集与 hash)。

## CLI 冒烟(真实输出)

```
$ node cli.js /tmp/demo.jsonl --as-of 3
{"asOf":3,"visible":[{"id":"a2","ts":2,"op":"append","data":{"amount":200}},{"id":"r1","ts":3,"op":"revoke","targetId":"a1"}],"hidden":[{"id":"a1","reason":"revoked_by:r1"}],"hash":"a4ba3f2838ca7c1cf1625b3be3a43095180cac411d8a3ae9c45e0dde23d2018f"}
$ node cli.js /tmp/cycle.jsonl
E_REVOKE_CYCLE: revoke r2 would create a revoke cycle
exit=1
```
