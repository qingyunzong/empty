# 湖仓分区投影逆解析

目录服务需要可导入的 TypeScript 分区投影库，在 integer/date/enum/injected 规则下由查询谓词生成有限路径，并能从实际路径逆解析分区值。日期步长跨夏令时使用指定时区，零填充不改变数值；生成和逆解析必须满足往返，超预算返回未闭合而非截断结果。

## 规则定义

```ts
import { projectPaths, parsePath } from './index.ts';

const rules = [
  { type: 'integer', name: 'month', range: [1, 12], digits: 2 },
  { type: 'date', name: 'dt', range: ['2026-03-07', '2026-03-11'],
    format: 'yyyy-MM-dd', interval: 1, intervalUnit: 'day',
    timezone: 'America/New_York' },
  { type: 'enum', name: 'region', values: ['us', 'eu', 'ap'] },
  { type: 'injected', name: 'tenant' },
];
```

- `integer`：`range` 界定取值域，`digits` 生成零填充段（`7` → `07`），逆解析时填充不改变数值。
- `date`：`format` 支持 `yyyy MM dd HH mm ss` 令牌；`interval`/`intervalUnit` 按规则时区的挂钟语义步进，跨夏令时不漂移、不重复；不带偏移量的边界与谓词值按规则时区解释为本地时间，带 `Z` 或偏移量的按瞬时处理。
- `enum`：仅允许 `values` 内取值，谓词过滤后求交。
- `injected`：只能由 `eq`/`in` 谓词注入；缺少谓词时投影未闭合。

## 投影生成

```ts
const result = projectPaths(rules, {
  dt: { op: 'range', min: '2026-03-08', max: '2026-03-10' },
  month: { op: 'in', values: [3, 4] },
  region: { op: 'eq', value: 'ap' },
  tenant: { op: 'eq', value: 'acme' },
}, { template: 'd={dt}/m={month}/r={region}/t={tenant}', maxPaths: 1000 });
// result.closed === true 时 result.paths 为完整有限路径集合
```

谓词支持 `eq` / `in` / `range`（`range` 仅用于 integer/date，闭区间）。笛卡尔积超过 `maxPaths`（默认 1000）或 injected 列缺少谓词时返回 `{ closed: false, paths: [] }`，绝不返回截断列表。

## 逆解析

```ts
parsePath(rules, 'd=2026-03-08/m=03/r=ap/t=acme', 'd={dt}/m={month}/r={region}/t={tenant}');
// { dt: '2026-03-08T05:00:00.000Z', month: 3, region: 'ap', tenant: 'acme' }
```

不匹配模板、整数值越界、枚举值未声明或日期段非法时返回 `null`。生成的路径经 `parsePath` 逆解析后，可用其结果作为 `eq` 谓词重新投影出同一条路径（往返一致）。

## 脚本

- `npm run typecheck`：严格类型检查。
- `npm test`：编译至 `.build/` 后运行 `node:test` 用例（本机 node 未编译类型剥离支持，故先经 `tsc` 转译；库源码仅使用可擦除语法，在支持 `--experimental-strip-types` 的环境中可直接导入 `index.ts`）。
