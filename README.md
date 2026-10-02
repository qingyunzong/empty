# downtime-policy-gate

工厂停机根因报告发布前的策略闸：按字段级权限生成操作员 / 供应商 / 总部视图，
防止配方（recipe）与个人信息（pii）泄露，并输出泄露审计。Node.js 22，仅标准库。

## 使用

```sh
node src/cli.js generate \
  --policy examples/field-policy.json \
  --reports examples/reports.jsonl \
  --redactions examples/redactions.jsonl \
  --out views --audit leak-audit.jsonl

node src/cli.js verify --views views
```

## 机制

- **继承**：字段权限沿 组织 → 角色 → 个人 继承；各层 `allow` 累积，任一层 `deny` 优先；
   clearance 取最具体一层（个人 > 角色 > 组织）。
- **分类升级**：`labels.*.upgradeTo` 可强制提升字段的有效分类等级（如 `recipe` → secret），
  即使被显式授权，clearance 不足也不可见。
- **共享视图**：供应商视图与总部视图冲突时取交集（`shared = supplier ∩ hq`），
  监管字段（`regulatory` 标签）强制并入，始终可见。
- **撤销**：`redactions.jsonl` 中的 `revoke` 生效后，已生成视图文件保留原哈希并改名
  `*.expired.<hash12>.json`、标记 `status: "expired"`（仍可 `verify` 校验）；
  新视图完全不含被撤字段（pii 字段也不再置 null，而是整体剔除）。
- **PII 边界**：未获授权的 pii 字段在视图中以 `null` 占位（边界空值），不省略、不泄露。
- **审计**：`leak-audit.jsonl` 中 `view-audit` 记录每个输出字段的授权路径
  （grants 链 / clearance / classification / regulatory）；`counterexample` 给出使供应商
  视图泄露配方的最小字段集（distance = 缺失授权数 + clearance 等级差，0 表示正在泄露）。

## 退出码

| 码 | 含义 |
|----|------|
| 28 | 未知分类（字段分类 / 标签升级目标 / clearance 引用了未定义的分类） |
| 29 | 视图哈希缺输入（视图文件缺少 `inputs`，无法重算哈希） |
| 30 | 监管字段被删（redaction 试图撤销监管字段） |

## 测试

```sh
node --test
```

验收覆盖：A 交集与监管例外（test/views.test.js）；B 撤销后旧视图过期可验
（test/redactions.test.js、test/cli.test.js）；C 个人信息边界空值（test/views.test.js）；
D ≤15 字段枚举全部 2^15 子集并对照暴力参考实现（test/enumerate.test.js）。
