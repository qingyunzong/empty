# 测试结果

- 日期：2026-10-02T13:27:01Z（UTC）
- 环境：v22.22.1，Linux，仅标准库
- 命令：`node --test`

## 子测试（node test/auditlog.test.js）

```
ok 1 - 1. revoke changes the view across its timestamp
ok 2 - 2. revoking a revoke restores visibility and the original hash
ok 3 - 3. revoke cycles are rejected with E_REVOKE_CYCLE
ok 4 - 4. randomized logs (n<=8) match reference replay at every asOf
ok 5 - CLI prints views for asOf commands and --as-of
ok 6 - CLI reports E_REVOKE_CYCLE on stderr with exit code 1
ok 7 - CLI reports parse and schema errors on stderr with exit code 1
ok 8 - canonicalize is key-order independent
```

## node --test 汇总

```
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4501.929617
```

全部 8 个测试通过，0 失败。覆盖验收标准：

1. 撤销后 asOf 前后视图与哈希不同（测试 1）
2. 撤销的撤销恢复可见且哈希回到仅由可见条目决定的值（测试 2）
3. 撤销环（自撤销、两节点、三节点）报 `E_REVOKE_CYCLE`（测试 3、6）
4. n<=8 随机操作序列（每 n 150 组种子），枚举所有 asOf 时刻与独立参考重放实现对照可见性、隐藏原因与哈希（测试 4）
