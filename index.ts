export type {
  Catalog,
  Expr,
  JoinType,
  RelNode,
  SelectItem,
} from "./src/ast.js";
export {
  AmbiguousColumnError,
  LineageError,
  UnknownColumnError,
  UnknownTableError,
} from "./src/errors.js";
export { canonicalKey, normalizeExpr, normalizeRel } from "./src/normalize.js";
export { analyzeLineage } from "./src/lineage.js";
export type { ColumnLineage, SourceColumn } from "./src/lineage.js";
