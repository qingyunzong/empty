# 采集表格的多级表头归属

文档采集器通过可导入的TypeScript表头关联包，输入已展开成矩形的单元格网格，跨度位置引用同一单元格对象，每格有唯一ID、角色data或header、scope为row、col或none以及显式headers ID列表。对每个data格，非空headers列表按给定顺序递归展开其中header的headers依赖，只保留没有进一步依赖的header，按首次到达去重；缺ID、引用data或依赖环使整表失败并返回可复现路径。没有显式headers时，收集覆盖其任一行且整格在其左侧的row表头，再收集覆盖其任一列且整格在其上方的col表头，各组按左上角的行列顺序去重。被引用次数不影响顺序；跨行列data结果按其左上角排序。输出表头ID路径及data原文本，禁止改输入。测试菱形依赖、跨列跨行、显式覆盖自动关联和环。

## 用法

```ts
import { associateHeaders, HeaderAssociationError } from './index.js';

const results = associateHeaders(grid);
// => [{ dataId: 'd1', text: '原始文本', headerPath: ['h-a', 'h-b'] }]
```

- `grid` 为矩形 `Cell[][]`；跨度位置引用同一个单元格对象，跨度范围由对象同一性推导，无需显式 rowSpan/colSpan。
- 每个 `Cell` 含 `id`、`role('data'|'header')`、`scope('row'|'col'|'none')`、显式 `headers: string[]` 与 `text`。
- 函数只读输入，不修改任何单元格或网格。

## 关联规则

- **显式优先**：`headers` 非空时按给定顺序深度优先递归展开，仅保留自身无进一步依赖的叶子 header；叶子按首次到达去重，引用次数不影响顺序。
- **自动关联**：`headers` 为空时，先取与 data 任一行重叠且整格位于其左侧的 `row` 表头，再取与任一列重叠且整格位于其上方的 `col` 表头；两组各自按左上角（先行后列）排序并按 ID 去重，row 组整体排在 col 组之前。
- **结果排序**：data 结果按其左上角（先行后列）排序，输出仅含 `dataId`、原样 `text` 与 `headerPath`。

## 整表失败

出现以下任一情况，整个表抛出 `HeaderAssociationError`（含稳定的 `code` 与可复现 `path`，路径从 data 格 ID 起沿依赖边到失败点）：

- `MISSING_HEADER_ID`：引用了不存在的 header ID。
- `HEADER_REFERS_TO_DATA`：header 引用指向了 data 单元格。
- `CYCLIC_HEADER_DEPENDENCY`：header 依赖成环（含自环）。

## 模块结构

- `src/types.ts`：公共类型。
- `src/errors.ts`：`HeaderAssociationError`。
- `src/geometry.ts`：跨度推导、索引与几何判定。
- `src/explicit.ts`：显式 headers 递归展开、去重与环/缺失/data 引用校验。
- `src/implicit.ts`：基于几何的 row/col 自动关联。
- `src/associate.ts`：主入口 `associateHeaders`。

## 构建与测试

本环境的 Node 未内置 TypeScript 剥离能力，因此先用全局 `tsc` 编译到 `dist/`，再用 Node 内置 test runner 执行：

```bash
npm run build      # tsc -p tsconfig.json
npm run typecheck  # 仅类型检查
npm test           # pretest 编译后运行 dist/test 下的 *.test.js
```

测试覆盖菱形依赖、跨行跨列、显式覆盖自动关联、依赖环，以及缺失 ID、引用 data、空 headers 隐式关联与输入不可变等边界。
