# 数据血缘列级表达式传播

元数据服务要可导入的 TypeScript 列级血缘库，输入关系代数 AST，处理投影、别名、join、union、聚合、窗口与 correlated subquery。每个输出列返回源列集合及变换路径；星号按输入 schema 世代展开，歧义列不猜测。等价 AST 规范化后血缘稳定。

## 用法

```ts
import { analyzeLineage } from "./index.ts";
import type { Catalog, RelNode } from "./index.ts";

const catalog: Catalog = {
  tables: { users: ["id", "name"], orders: ["oid", "user_id", "amount"] },
};

const ast: RelNode = {
  kind: "project",
  input: { kind: "scan", table: "users" },
  items: [{ expr: { kind: "column", name: "name" }, alias: "uname" }],
};

const lineage = analyzeLineage(ast, catalog);
// => [{ name: "uname",
//       sources: [{ table: "users", column: "name" }],
//       path: ["project", "alias:uname"] }]
```

## 设计

- `src/ast.ts` — 关系代数 AST 类型：`scan / project / filter / join / union / aggregate`，表达式含列引用、星号、函数、case、窗口与标量子查询。
- `src/normalize.ts` — AST 规范化：交换律操作数排序、结合律展平、inner join 输入与 union 分支按规范键排序，保证等价 AST 血缘输出稳定。
- `src/lineage.ts` — 分析器：每个输出列返回 `sources`（排序去重的源列集合）与 `path`（变换路径，如 `join:inner`、`aggregate:sum`、`window:row_number`、`subquery:scalar`）。
- 星号按输入 schema 的世代（generation）顺序展开；带限定符的星号只展开对应输入。
- 列解析不猜测：未命中抛 `UnknownColumnError`，多候选抛 `AmbiguousColumnError`，未知表抛 `UnknownTableError`。
- correlated subquery 通过外层作用域链解析，相关谓词引用的外层列计入子查询表达式的源列集合。

## 脚本

- `npm run typecheck` — `tsc` 严格类型检查。
- `npm test` — 编译到 `build/` 后用 `node --test` 运行测试。
