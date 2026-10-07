# 实际测试结果

环境：Node.js v22.22.1，npm 9.2.0，tsc 7.0.2（TypeScript 原生预览），Linux x86_64。
日期：2026-10-08。命令：`npm test`（= `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`）。

## npm test 输出（退出码 0）

```
TAP version 13
# Subtest: dist/test/pivot.test.js
ok 1 - dist/test/pivot.test.js
  ---
  duration_ms: 318.373358
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## 测试文件内逐项结果（node dist/test/pivot.test.js）

```
ok 1 - 多层行列键汇总：树状行列、小计与总计
ok 2 - 精确整数：超出 Number.MAX_SAFE_INTEGER 仍精确
ok 3 - NULL 独立分类：null 与字符串 "null" 及其他键互不混淆
ok 4 - 小计不重复计算叶数据：subtotal = direct + 子节点之和，每叶只计一次
ok 5 - 更正带事件 ID：同一 eventId 幂等，重复提交不影响结果
ok 6 - 空组核对：净额为 0 的组不进树，且在核对报告中列出
ok 7 - 跨组迁移：更正链把金额从 A×X 迁到 B×Y，总计守恒且被报告
ok 8 - 非法输入被拒绝
ok 9 - 综合场景：reconcile 与全表分组一致（含 NULL、空组、迁移、大数）
# tests 9
# pass 9
# fail 0
```

## 树状输出示例（renderPivot）

输入事件：`华东/上海×2025/Q1=100`、`华东/上海×2025/Q2=50`、`华东/NULL×2025/Q1=30`、`NULL×NULL=7`。

```
行树:
  (根) = 187
    NULL = 7
    "华东" = 180
      NULL = 30
      "上海" = 150
列树:
  (根) = 187
    NULL = 7
    "2025" = 180
      "Q1" = 130
      "Q2" = 50
单元格:
  NULL × NULL = 7
  "华东" / NULL × "2025" / "Q1" = 30
  "华东" / "上海" × "2025" / "Q1" = 100
  "华东" / "上海" × "2025" / "Q2" = 50
总计: 187
```
