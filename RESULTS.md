# RESULTS

- 日期: 2026-10-02 20:41:04 UTC
- Node: v22.22.1
- 命令: `node --test`

## 汇总（真实输出）

```
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

两个测试文件全部通过：`test/engine.test.js`（10 个用例）、`test/cli.test.js`（4 个用例），共 14 个用例，0 失败。

## 逐用例结果（真实输出）

```
--- node --test (per-file detail) ---
ok 1 - CLI tool life writes tools.jsonl, parts.jsonl, risk.json, late.log
ok 2 - CLI exits 1 and reports LIFE_INVALID for newLife <= 0
ok 3 - CLI usage error without required args
ok 4 - CLI skips malformed JSONL lines with a warning
ok 1 - wear formula is non-linear: seconds * (force / rated)^2
ok 2 - acceptance 3: wear order enumeration matches expected remaining sequence
ok 3 - acceptance 4: wearing exactly to zero is not EXHAUST
ok 4 - acceptance 2: retracting a load rolls back wear and restores the segment
ok 5 - acceptance 1: late qc flips the risk chain of subsequent parts
ok 6 - retracting a GOOD qc pulls the part back to UNKNOWN and reopens the chain
ok 7 - multiple qc for one part: latest eventTs wins, ties broken by op id
ok 8 - change with newLife <= 0 is reported as LIFE_INVALID and skipped
ok 9 - retracting a change merges the following loads back into the prior segment
ok 10 - watermark and maxEventTs are exposed in the summary
```

## 验收标准对照

1. 迟到 qc 改变风险链 — "acceptance 1: late qc flips the risk chain of subsequent parts" ✔
2. load 撤回恢复刀具段 — "acceptance 2: retracting a load rolls back wear and restores the segment" ✔
3. 小例枚举磨损顺序对照 — "acceptance 3: wear order enumeration matches expected remaining sequence" ✔
4. 恰好磨损到 0 不算超额 — "acceptance 4: wearing exactly to zero is not EXHAUST" ✔
