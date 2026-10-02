# RESULTS

## 环境

- Node.js: v22.22.1
- 平台: linux x64（容器沙箱）
- 日期: 2026-10-02 18:04:01 UTC
- 命令: `node --test`（全量，仅标准库 + node:test）

## 结果

退出码: 0（全部通过）

```
ok 1 - test/budget.test.js
ok 2 - test/cli.test.js
ok 3 - test/enumerate.test.js
ok 4 - test/lock.test.js
ok 5 - test/snapshot.test.js
ok 6 - test/unsat.test.js

# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 50285.386435
```

## 验收映射

- 验收1 unlock 触发重排且等价重算: test/lock.test.js
  `unlock triggers full re-schedule equivalent to a fresh recompute`（另见 cli.test.js 端到端用例）
- 验收2 快照嵌套恢复正确: test/snapshot.test.js
  `nested snapshots restore in LIFO order and expire future snapshots`
- 验收3 危险互斥 UNSAT 给最小配方集: test/unsat.test.js
  `hazardous atmosphere mutual exclusion yields UNSAT with minimal recipe core`
- 验收4 n<=9 枚举炉次对照: test/enumerate.test.js
  `solver matches brute-force enumeration on random instances with n<=9`（60 个种子实例，OPTIMAL/UNSAT 混合）
- 预算三类耗尽返回 PENDING 不误报 UNSAT: test/budget.test.js
- exit 0/2/3/4 语义: test/cli.test.js
