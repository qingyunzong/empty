export type Expr =
  | { kind: "column"; name: string; qualifier?: string }
  | { kind: "star"; qualifier?: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "func"; name: string; args: Expr[]; distinct?: boolean }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "unary"; op: string; operand: Expr }
  | {
      kind: "case";
      operand?: Expr;
      whens: ReadonlyArray<{ when: Expr; then: Expr }>;
      else?: Expr;
    }
  | {
      kind: "window";
      name: string;
      args: Expr[];
      partitionBy?: Expr[];
      orderBy?: ReadonlyArray<{ expr: Expr; direction?: "asc" | "desc" }>;
    }
  | { kind: "subquery"; query: RelNode };

export interface SelectItem {
  expr: Expr;
  alias?: string;
}

export type JoinType = "inner" | "left" | "right" | "full" | "cross";

export type RelNode =
  | { kind: "scan"; table: string; alias?: string }
  | { kind: "project"; items: SelectItem[]; input: RelNode; alias?: string }
  | { kind: "filter"; predicate: Expr; input: RelNode; alias?: string }
  | {
      kind: "join";
      joinType: JoinType;
      left: RelNode;
      right: RelNode;
      on?: Expr;
      alias?: string;
    }
  | { kind: "union"; all?: boolean; inputs: RelNode[]; alias?: string }
  | {
      kind: "aggregate";
      groupBy: SelectItem[];
      aggregates: SelectItem[];
      input: RelNode;
      alias?: string;
    };

export interface Catalog {
  tables: Record<string, readonly string[]>;
}
