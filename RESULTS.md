# 测试结果（真实记录）

- 环境：Node.js v22.22.1，单机离线，仅标准库 + node:test
- 命令：`node --test`
- 日期：2026-10-03

## 汇总

```
ok 1 - test/cli.test.js
ok 2 - test/enumerate.test.js
ok 3 - test/persistence.test.js
ok 4 - test/rollback.test.js
ok 5 - test/sync.test.js
ok 6 - test/validation.test.js
# tests 6
# pass 6
# fail 0
# duration_ms 7843.56569
```

共 33 个子测试，全部通过。

## 明细

### test/validation.test.js —— 越界与联锁（VALIDATION）
- ok 1 - set captures change and bumps version vector
- ok 2 - out-of-range value is rejected with VALIDATION
- ok 3 - wrong type is rejected with VALIDATION
- ok 4 - interlock violation is rejected with VALIDATION
- ok 5 - unknown key and bad expressions are VALIDATION errors
- ok 6 - lock/unlock are captured; set on locked param fails

### test/rollback.test.js —— 回滚顺序（ROLLBACK）
- ok 1 - rollback hierarchy: unlock -> revert -> cert-clear succeeds in order
- ok 2 - revert before unlock is a ROLLBACK error
- ok 3 - cert-clear before revert is a ROLLBACK error
- ok 4 - cert store duplicate issue and missing revoke are ROLLBACK errors

### test/persistence.test.js —— 三故障点恢复
- ok 1 - fault before-delta-append: no partial delta, recovery keeps safe values
- ok 2 - fault after-delta-append: uncommitted delta is overridden by safe set
- ok 3 - fault before-active-rename: old snapshot intact, dangerous delta covered
- ok 4 - fault after-manifest-commit: manifest committed, recovery consistent
- ok 5 - partial delta tail is discarded, never half-applied
- ok 6 - clean commit round-trips full state

### test/sync.test.js —— 版本向量合并与 pending
- ok 1 - version vector compare: gt/lt/eq/concurrent
- ok 2 - dominant side wins, merged vv is element-wise max
- ok 3 - concurrent non-safety conflict resolves deterministically
- ok 4 - safety-critical concurrent conflict must be pending, never auto-resolved
- ok 5 - safety-critical dominant update merges without pending

### test/enumerate.test.js —— n≤7 枚举安全收敛对照
- ok 1..7 - safe convergence enumeration n=1..7（2^n 子集 × 4 故障点）
- ok 8 - reference safe state is all-safe for n<=7

枚举场景数与收敛结果（实跑）：

| n | 场景数 (2^n × 4) | 收敛 |
|---|------------------|------|
| 1 | 8   | true |
| 2 | 16  | true |
| 3 | 32  | true |
| 4 | 64  | true |
| 5 | 128 | true |
| 6 | 256 | true |
| 7 | 512 | true |

### test/cli.test.js —— CLI 退出码 2/3/11 与 stderr JSON
- ok 1 - pack + apply happy path
- ok 2 - out-of-range value exits 2 with VALIDATION JSON on stderr
- ok 3 - interlock violation exits 2
- ok 4 - safety-critical sync conflict exits 11 with SYNC_PENDING
- ok 5 - rollback wrong phase order exits 3 with ROLLBACK
- ok 6 - cert lifecycle via CLI
- ok 7 - fault injection via env: crash then recover, no half-apply
