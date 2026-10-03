# settlement-audit-sampler

审计抽样库与 CLI (Node.js 22, 仅标准库): 结算流程正则 → 编译并最小化自动机,
对事件日志 (申请 apply / 复核 review / 放行 release / 入账 post / 冲正 reverse) 做
接受判定、最短编辑距离修复与双口径等价判定。

## 用法

```
node cli.js check flow.re log.jsonl [--k N]   # 检查日志, 输出 accept/witness/repairs
node cli.js equiv left.re right.re            # 等价判定, 输出 equiv/witness
node --test                                   # 运行测试
```

## 流程正则语法

- 事件: `apply review release post reverse` (或中文 申请/复核/放行/入账/冲正)
- 连接: `apply review` · 选择: `a|b` · 闭包: `a*` `a+` `a?` · 分组: `(...)`
- 空串: `eps`/`ε` · 空语言: `empty`/`∅`

## 日志格式 (JSONL)

每行一个事件: JSON 字符串 (`"apply"`) 或对象 (`{"event":"apply"}`)。

## 规则与限制

- 冲正不能撤销未入账 (全局监控自动机与流程自动机求交)。
- 未知事件立即拒绝; 空日志仅在正则接受空串时通过。
- 日志 ≤ 200 事件; 修复仅插入/删除 (替换 = 删除+插入), K ≤ 6, 并列方案按
  事件名字典序输出至多 10 条。
- 错误码: `EMPTY_ALPHABET` `LOG_TOO_LONG` `NO_REPAIR_WITHIN_K` `NONTERM_AUTOMATON`。

## 结构

- `src/regex.js` 正则解析 · `src/automata.js` NFA→DFA→最小化, 模拟
- `src/flow.js` 编译 + 冲正监控乘积 · `src/repair.js` 修复枚举
- `src/equiv.js` 等价判定 + 独立枚举器 · `src/check.js` 日志检查编排
- `cli.js` 命令行入口 · `test/` node:test 测试 · `RESULTS.md` 真实测试结果
