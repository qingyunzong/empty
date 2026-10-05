# row-authz-query

行级三值授权查询库（TypeScript，零第三方依赖，仅用 Node.js 内置模块）。

## 模型

- **三值策略**：每个行属性条件求值为 `allow` / `deny` / `unknown`（Kleene 逻辑）。
  引用的字段缺失（或类型不匹配、对 `null` 做排序比较）时求值为 `unknown`。
- **策略合并**：deny 优先；任一规则为 `unknown` 则结果为 `unknown`；否则任一 allow 即 allow；
  无规则命中时取策略默认值。`unknown` 的行**不视为已授权**，过滤与聚合均将其排除。
- **同一策略快照**：`buildSnapshot` 对有限输入表一次性求值，得到每行访问决策与每字段遮盖决策；
  过滤、字段遮盖、聚合全部消费该快照，保证一致性。遮盖值为 `null`。
- **先授权再聚合**：聚合只在已授权（且通过查询 `where`）的行上进行，绝不先聚合未授权行；
  聚合读取的是遮盖后的投影值。
- **输出来源行 ID**：结果行始终携带源表 `id`，保持源表顺序。

## 两个独立实现互相核对：

- `runAuthorizeFirst`（`src/engineAuthorizeFirst.ts`）：先构建授权快照，再在快照上执行查询。
- `runInline`（`src/engineInline.ts`）：单遍扫描，逐行内联求值策略并累积聚合。
- `crossCheck`（`src/crosscheck.ts`）：对同一输入运行两者并 `deepStrictEqual` 比对。

## 使用

```ts
import { runAuthorizeFirst, crossCheck } from './src/index.js';

const policy = {
  rules: [
    { name: 'cleared', when: { op: 'gte', field: 'clearance', value: 2 }, effect: 'allow' },
    { name: 'no-hr', when: { op: 'eq', field: 'dept', value: 'hr' }, effect: 'deny' },
  ],
  default: 'deny',
  fields: [{ field: 'ssn', when: { op: 'gte', field: 'clearance', value: 3 } }],
};

const result = runAuthorizeFirst(table, policy, {
  aggregates: [{ op: 'sum', field: 'salary', as: 'total' }],
});
```

## 测试

```sh
npm test        # tsc 编译后运行 node --test（Node 内置测试运行器）
npm run typecheck
```

## 实际结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 输出（本环境 Node 构建将每个文件报告为一个测试单元，失败时退出码为 1，已验证）：

```
# tests 1
# pass 1
# fail 0
```

直接运行编译后的测试文件可见全部 12 条用例，全部通过：

```
ok 1 - three-valued logic follows Kleene truth tables
ok 2 - missing field evaluates to unknown
ok 3 - policy decisions: deny overrides allow, missing field yields unknown
ok 4 - snapshot is the single source for filter and mask
ok 5 - filter returns only authorized source row ids, masking applied from same snapshot
ok 6 - aggregation never includes unauthorized rows
ok 7 - query where is three-valued: unknown rows are excluded
ok 8 - select projection keeps id and masks per snapshot
ok 9 - empty authorized set yields count 0 and null avg/min/max
ok 10 - fixed scenario: authorize-first and inline engines agree
ok 11 - randomized cross-check: 300 generated tables/policies/queries agree
ok 12 - inline engine alone also respects authorize-before-aggregate
# tests 12
# pass 12
# fail 0
```

关键断言（固定场景）：5 行表中仅行 1、5 授权（行 2 默认拒绝、行 3 被 deny 规则覆盖、
行 4 缺 `clearance` 字段为 `unknown`）；`sum(salary)` = 400，而未授权朴素全表和为 870；
行 1 的 `ssn` 被遮盖为 `null`，行 5 的 `ssn` 可见。随机化核对用固定种子
（mulberry32, seed=20261006）生成 300 组表/策略/查询，两引擎结果全部一致。
