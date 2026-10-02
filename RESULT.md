# RESULT

提交前真实测试记录。

- 环境：Node.js v22.22.1，仅标准库，离线
- 命令：`node --test`
- 日期：2026-10-03（Asia/Shanghai）

## 结果

```
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10851.909666
```

**8/8 测试文件全部通过，0 失败。**

## 覆盖对照

| 验收项 | 测试文件 | 结果 |
|--------|----------|------|
| A 交集与监管例外 | test/views.test.js | 通过 |
| B 撤销后旧视图过期可验 | test/redactions.test.js, test/cli.test.js | 通过 |
| C 个人信息边界空值 | test/views.test.js | 通过 |
| D ≤15 字段枚举所有视图对照（2^15 子集 × 4 视图 vs 暴力参考实现） | test/enumerate.test.js | 通过 |
| 退出码 28/29/30 | test/policy.test.js, test/cli.test.js, test/redactions.test.js | 通过 |

另做了端到端冒烟：`examples/` 下 generate 产出 8 个视图文件（2 报告 × operator/supplier/hq/shared），
`verify` 全部 `ok`，`leak-audit.jsonl` 含 view-audit 与 counterexample 记录
（`minimalFieldSet: ["recipe_ratio"]`, `distance: 3`, `leaking: false`）。
