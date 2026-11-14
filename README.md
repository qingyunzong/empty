# 缺失值语义映射

异构数据入口要可导入的 TypeScript 缺失值归一组件，按字段 schema 区分 absent、null、empty、NaN、sentinel 和 redacted。映射规则版本化且保留原始表示；不允许把合法零值或空集合当缺失。输出值、缺失类别和规则证据，支持无损回查。

## 使用

```ts
import { normalizeRecord, restoreRecord, type MappingRuleset } from './index.js';

const ruleset: MappingRuleset = {
  version: '1.0.0', // 规则版本，写入每条证据
  fields: {
    age: { type: 'integer', sentinels: [-999] },
    ssn: { type: 'string', redactedMarkers: ['***'] },
    tags: { type: 'array' }, // 空数组是合法值，不归缺失
  },
};

const normalized = normalizeRecord({ age: -999, ssn: '***', tags: [] }, ruleset);
// normalized.age    -> { value: undefined, category: 'sentinel', evidence: {...} }
// normalized.tags   -> { value: [], category: 'present', ... } 空集合不当缺失

const original = restoreRecord(normalized); // 无损还原原始表示
```

## 缺失类别判定顺序

`absent`（键缺失 / undefined 值）→ `null` → `nan` → `redacted` → `sentinel` → `empty`（空白串；空集合需 schema 显式开启 `emptyCollectionIsMissing`）→ 类型校验 → `present`。

合法零值（`0`、`0n`、`false`）与空集合（`[]`、`{}`）默认视为有效值。每个字段的输出包含归一值、缺失类别与规则证据（`rulesetVersion`、`ruleId`、原始表示、命中 token），证据可 JSON 序列化（NaN/undefined/bigint 使用 tagged 编码），`restoreRecord` 支持无损回查。

## 命令

- `npm run build`：编译到 `dist/`
- `npm run typecheck`：严格类型检查
- `npm test`：编译并运行 `node:test` 测试
