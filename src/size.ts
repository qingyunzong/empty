import type { TypeNode } from "./schema.js";

/**
 * 类型的静态字节大小；含运行时引用（长度/计数/条件字段）时返回 null。
 * 仅在校验通过的 schema 上调用（无循环、固定乘积不溢出）。
 */
export function staticSizeOf(
  node: TypeNode,
  types: Record<string, TypeNode>,
  memo: Map<TypeNode, number | null> = new Map()
): number | null {
  if (memo.has(node)) {
    return memo.get(node)!;
  }
  let size: number | null;
  switch (node.kind) {
    case "uint":
      size = node.bits / 8;
      break;
    case "bytes":
      size = typeof node.length === "number" ? node.length : null;
      break;
    case "array": {
      if (typeof node.count === "number") {
        const elem = staticSizeOf(node.element, types, memo);
        size = elem === null ? null : node.count * elem;
      } else {
        size = null;
      }
      break;
    }
    case "struct": {
      let total = 0;
      let fixed = true;
      for (const f of node.fields) {
        if (f.when) {
          fixed = false;
          break;
        }
        const s = staticSizeOf(f.type, types, memo);
        if (s === null) {
          fixed = false;
          break;
        }
        total += s;
      }
      size = fixed ? total : null;
      break;
    }
    case "ref":
      size = staticSizeOf(types[node.name] as TypeNode, types, memo);
      break;
  }
  memo.set(node, size);
  return size;
}
