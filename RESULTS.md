# RESULTS

日期: 2026-10-03 17:28:29 CST
Node: v22.22.1
命令: `node --test`（退出码 0）

## 汇总（真实输出）

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 4422.537025
```

## 各测试文件

```
ok 1 - test/audit-retract.test.js
ok 2 - test/conflict.test.js
ok 3 - test/crash.test.js
ok 4 - test/enumerate.test.js
ok 5 - test/hashbad.test.js
ok 6 - test/late.test.js
```

## 验收映射

- 验收1（rename 前后各崩溃一次结果一致）→ `test/crash.test.js`
- 验收2（audit 撤回回滚放行）→ `test/audit-retract.test.js`
- 验收3（<=5 frame 枚举对照隔离集）→ `test/enumerate.test.js`
- 验收4（跨 SKU 冲突边界）→ `test/conflict.test.js`
- 附加：`test/hashbad.test.js`（HASH_BAD）、`test/late.test.js`（水位线迟到事件）
