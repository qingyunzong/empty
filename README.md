# policy-diff

在有限属性域上寻找使两个策略决议不同的**最小属性赋值**（差异见证）。仅使用 TypeScript 与 Node.js 内置库，无运行时依赖。

## 用法

```bash
npm run build                          # 编译到 dist/
node dist/src/cli.js <输入.json | -> [--budget N]
npm test                               # 编译并运行全部测试
```

输入为 JSON（文件路径或 `-` 表示标准输入）：

```json
{
  "attributes": { "role": ["admin", "user"], "mfa": ["on", "off"] },
  "policies": {
    "A": { "default": "deny", "rules": [{ "when": { "role": "admin" }, "decision": "permit" }] },
    "B": { "default": "deny", "rules": [{ "when": { "role": "admin", "mfa": "on" }, "decision": "permit" }] }
  },
  "budget": 1000000
}
```

- `attributes`：属性名到有限取值数组，**数组顺序即取值序**；属性名按字典序排列。
- `policies`：恰好两个策略。每个策略含 `default` 决议与**至多 20 条规则**；规则按序匹配，首条 `when` 全部命中的规则生效，否则取 `default`。
- `budget`：可选，求值预算（默认 1,000,000），即可检查的部分赋值个数上限；命令行 `--budget` 可覆盖。

## 语义

- **部分赋值**：只为部分属性指定取值，未指定的属性视为自由。
- **部分赋值下的决议**：若该赋值的所有补全（自由属性遍历其域）下某策略决议相同，则决议**确定**，否则**未确定**。
- **差异见证**：两策略在该部分赋值下决议都确定且不同。
- **最小性序**：先按已指定字段数升序；同层内属性子集按属性名字典序、取值元组按各属性域序（字典积序）。枚举到的第一个见证即最小见证。
- **结论**：
  - `DIFFERENT`：输出最小见证（仅含已指定字段）及两策略各自决议。
  - `EQUIVALENT`：已**穷尽**全部 ∏(域大小+1) 个部分赋值，两策略决议始终一致。
  - `UNDECIDED`：预算耗尽，既未找到差异也未穷尽空间，结论**未决**。
- **退出码**：`0` = 已得结论（DIFFERENT/EQUIVALENT），`3` = UNDECIDED，`1` = 输入非法，`4` = 交叉核对失败。

## 独立枚举交叉核对

求解过程中并行运行两套独立实现并逐条比对，任一不一致即报错（退出码 4）：

1. **枚举核对**：递归组合生成器（`enumerateRecursive`）与迭代里程表生成器（`enumerateOdometer`，组合后继 + 取值里程表）必须产生完全相同的赋值序列。
2. **求值核对**：精确递归求值器（`possibleDecisions`，按首条存活规则的不确定性分支）与暴力补全求值器（`possibleDecisionsBrute`，枚举全部补全）在每个被检查的赋值上结果必须一致；补全空间超过 65,536 时跳过并标注 `skipped`。

## 目录

- `src/model.ts`：输入校验（含 20 条规则上限）与两种求值器
- `src/enumerate.ts`：两种独立枚举器与空间大小计算
- `src/solve.ts`：求解驱动（最小性序、预算、三种结论、交叉核对）
- `src/cli.ts`：命令行入口
- `test/`：基于 `node:test` 的测试（含随机化双求值器对拍）
- `examples/`：差异 / 等价 / 未决三个示例
- `RESULTS.md`：`npm test` 与示例的实际运行结果
