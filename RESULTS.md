# RESULTS — 真实运行记录

环境：Node.js v22.22.1（仅标准库），离线单机，2026-10-03。

## 1. `node --test`（全部测试，8/8 通过）

```
ok 1 - freeze merge + unfreeze cut
ok 2 - debit priority: explicit-freeze > category-limit > total-limit
ok 3 - same-ts debits: lexicographic id decides the unique winner
ok 4 - duplicate id -> E_DUP, no side effect, audited
ok 5 - audit chain verifies and detects tampering
ok 6 - interval primitives
ok 7 - random small states (<=100) match brute-force interval maintenance
ok 8 - cli: exit codes, stderr, report file
# tests 1
# pass 1
# fail 0
```

（`node --test` 汇总：`tests 1, pass 1, fail 0`；文件内 8 个 subtest 全部 ok。）

## 2. 验收标准对应

| 验收 | 测试 | 结果 |
|---|---|---|
| 1 重叠冻结合并与解冻切割 | `freeze merge + unfreeze cut` | 通过：[10,40]+[30,60]→[10,60]；切 [20,50]→[10,20],[50,60]；未覆盖/越界解冻 E_RANGE |
| 2 分类限额失败但总限额足够 | `debit priority: explicit-freeze > category-limit > total-limit` | 通过：food 40/50 后再扣 20 → E_LIMIT category-limit（总额 60<100 足够）；并验证显式冻结优先于分类、总限额兜底 |
| 3 同刻并列扣款按 id 决定唯一成功 | `same-ts debits: lexicographic id decides the unique winner` | 通过：同 ts 三笔 60 元扣款，仅 id 最小的 req-a 成功；输入乱序结果不变 |
| 4 随机小状态 vs 暴力区间对照 | `random small states (<=100) match brute-force interval maintenance` | 通过：种子 20261003，100 组随机场景（totalLimit 10..100，含同刻冲突与重复 id），逐步对照 ok/code/frozen/available/spent 与单位槽位暴力参考实现完全一致 |

## 3. CLI 真实运行：`node cli.js examples/ops.jsonl examples/report.json`

stderr（退出码 1，因存在业务失败）：

```
E_LIMIT id=d-02 op=debit reason=category-limit: 'food' 40+20 > 50
E_LIMIT id=d-b op=debit reason=total-limit: 100+60 > 100
E_LIMIT id=d-c op=debit reason=total-limit: 100+60 > 100
E_DUP id=d-a op=debit reason=duplicate request id 'd-a'
E_RANGE id=u-04 op=unfreeze reason=range [5, 15] is not fully frozen
```

report.json 逐步摘要（ts id op 结果 可用额/已扣/冻结区间）：

```
1  f-01  freeze    ok       avail=10  spent=0   frozen=[[10,40]]
2  f-02  freeze    ok       avail=10  spent=0   frozen=[[10,60]]        # 重叠合并
3  u-01  unfreeze  ok       avail=10  spent=0   frozen=[[10,20],[50,60]] # 中间切割
4  u-02  unfreeze  ok       avail=50  spent=0   frozen=[[50,60]]
5  u-03  unfreeze  ok       avail=100 spent=0   frozen=[]
6  d-01  debit     ok       avail=60  spent=40  frozen=[]
7  d-02  debit     E_LIMIT  avail=60  spent=40  frozen=[]   # 分类限额(总额够)
8  d-a   debit     ok       avail=0   spent=100 frozen=[]   # 同刻竞争唯一成功
8  d-b   debit     E_LIMIT  avail=0   spent=100 frozen=[]
8  d-c   debit     E_LIMIT  avail=0   spent=100 frozen=[]
9  d-a   debit     E_DUP    avail=0   spent=100 frozen=[]   # 重复 id，无副作用
10 u-04  unfreeze  E_RANGE  avail=0   spent=100 frozen=[]   # 解冻未冻结区间
final: available=0 spent=100 spentByCat={food:40,other:60} frozen=[]
auditValid: true, auditChain 长度 12
```

## 4. 错误路径实测

- 缺参数：`node cli.js` → stderr `usage: node cli.js <ops.jsonl> <report.json>`，退出码 1。
- 输入文件不存在 → stderr `E_IO cannot read ...`，退出码 1。
- 非法 JSON 行 / 字段缺失 / 重复 config 行 → stderr `E_PARSE ...`，退出码 1，不写报告。
- 全部请求成功时退出码 0（见测试 8 的 ok 场景）。
