export type BinaryOp = "and" | "or" | "xor" | "implies" | "iff";

export type Expr =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "not"; readonly operand: Expr }
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr };

export function collectVars(exprs: readonly Expr[]): string[] {
  const set = new Set<string>();
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case "const":
        break;
      case "var":
        set.add(e.name);
        break;
      case "not":
        walk(e.operand);
        break;
      case "binary":
        walk(e.left);
        walk(e.right);
        break;
    }
  };
  for (const e of exprs) walk(e);
  return [...set].sort();
}
