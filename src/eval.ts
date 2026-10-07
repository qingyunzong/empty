import type { Expr } from "./ast.js";

export type Lookup = (name: string) => boolean;

/** Primary evaluator: straightforward structural recursion. */
export function evaluate(expr: Expr, get: Lookup): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "var":
      return get(expr.name);
    case "not":
      return !evaluate(expr.operand, get);
    case "binary": {
      switch (expr.op) {
        case "and":
          return evaluate(expr.left, get) && evaluate(expr.right, get);
        case "or":
          return evaluate(expr.left, get) || evaluate(expr.right, get);
        case "xor":
          return evaluate(expr.left, get) !== evaluate(expr.right, get);
        case "implies":
          return !evaluate(expr.left, get) || evaluate(expr.right, get);
        case "iff":
          return evaluate(expr.left, get) === evaluate(expr.right, get);
      }
    }
  }
}

type PostfixItem =
  | { tag: "const"; value: boolean }
  | { tag: "var"; name: string }
  | { tag: "not" }
  | { tag: "op"; op: "and" | "or" | "xor" | "implies" | "iff" };

function toPostfix(expr: Expr): PostfixItem[] {
  const out: PostfixItem[] = [];
  const stack: Expr[] = [expr];
  // Iterative post-order traversal using a visited marker encoded by
  // re-pushing nodes; keeps this path free of recursion.
  const markers: Array<"enter" | "exit"> = ["enter"];
  while (stack.length > 0) {
    const node = stack.pop() as Expr;
    const mark = markers.pop() as "enter" | "exit";
    if (mark === "exit") {
      if (node.kind === "not") out.push({ tag: "not" });
      else if (node.kind === "binary") out.push({ tag: "op", op: node.op });
      continue;
    }
    switch (node.kind) {
      case "const":
        out.push({ tag: "const", value: node.value });
        break;
      case "var":
        out.push({ tag: "var", name: node.name });
        break;
      case "not":
        stack.push(node, node.operand);
        markers.push("exit", "enter");
        break;
      case "binary":
        stack.push(node, node.right, node.left);
        markers.push("exit", "enter", "enter");
        break;
    }
  }
  return out;
}

/**
 * Independent evaluator used only by the verifier: compiles the AST to
 * postfix form and runs it on an explicit value stack, so a bug in the
 * recursive evaluator cannot silently reproduce itself here.
 */
export function evaluateIndependent(expr: Expr, get: Lookup): boolean {
  const code = toPostfix(expr);
  const stack: boolean[] = [];
  for (const item of code) {
    switch (item.tag) {
      case "const":
        stack.push(item.value);
        break;
      case "var":
        stack.push(get(item.name));
        break;
      case "not": {
        const a = stack.pop();
        if (a === undefined) throw new Error("verifier: stack underflow");
        stack.push(!a);
        break;
      }
      case "op": {
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) throw new Error("verifier: stack underflow");
        switch (item.op) {
          case "and":
            stack.push(a && b);
            break;
          case "or":
            stack.push(a || b);
            break;
          case "xor":
            stack.push(a !== b);
            break;
          case "implies":
            stack.push(!a || b);
            break;
          case "iff":
            stack.push(a === b);
            break;
        }
        break;
      }
    }
  }
  if (stack.length !== 1) throw new Error("verifier: malformed postfix evaluation");
  return stack[0] as boolean;
}
