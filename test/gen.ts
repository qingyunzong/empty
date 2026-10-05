import { Buffer } from "node:buffer";
import type { FieldNode, Schema, StructNode, TypeNode } from "../src/schema.js";

/** mulberry32 确定性伪随机数发生器。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

/**
 * 生成随机合法 schema：1..3 个命名 struct 类型，root 为 T0；
 * 命名类型只向前引用（Ti -> Tj, j > i），保证定义图无环。
 * 长度/计数引用与 when 条件只指向同一 struct 中先前的无条件 uint 字段。
 */
export function genSchema(rng: () => number): Schema {
  const nTypes = int(rng, 1, 3);
  const types: Record<string, TypeNode> = {};
  for (let i = 0; i < nTypes; i++) {
    types[`T${i}`] = genStruct(rng, i, nTypes, 0);
  }
  return { root: "T0", types };
}

function genStruct(rng: () => number, selfIdx: number, nTypes: number, depth: number): StructNode {
  const nFields = int(rng, 1, 5);
  const fields: FieldNode[] = [];
  const uints: string[] = [];
  for (let k = 0; k < nFields; k++) {
    const name = `f${k}`;
    const type = genFieldType(rng, selfIdx, nTypes, depth, uints);
    const field: FieldNode = { name, type };
    if (uints.length > 0 && rng() < 0.3) {
      field.when = { field: pick(rng, uints), equals: int(rng, 0, 2) };
    }
    if (type.kind === "uint" && field.when === undefined) {
      uints.push(name);
    }
    fields.push(field);
  }
  return { kind: "struct", fields };
}

function genUint(rng: () => number): TypeNode {
  const node: TypeNode = { kind: "uint", bits: pick(rng, [8, 16, 32] as const) };
  if (rng() < 0.5) {
    (node as { littleEndian?: boolean }).littleEndian = true;
  }
  return node;
}

function genFieldType(
  rng: () => number,
  selfIdx: number,
  nTypes: number,
  depth: number,
  uints: readonly string[]
): TypeNode {
  const options: string[] = ["uint", "uint", "bytesFixed", "arrayFixed"];
  if (uints.length > 0) {
    options.push("bytesRef", "arrayRef");
  }
  if (depth < 2) {
    options.push("struct");
  }
  if (selfIdx + 1 < nTypes) {
    options.push("ref");
  }
  switch (pick(rng, options)) {
    case "uint":
      return genUint(rng);
    case "bytesFixed":
      return { kind: "bytes", length: int(rng, 0, 6) };
    case "bytesRef":
      return { kind: "bytes", length: { ref: pick(rng, uints) } };
    case "arrayFixed":
      return { kind: "array", count: int(rng, 0, 4), element: genElement(rng, selfIdx, nTypes, depth) };
    case "arrayRef":
      return { kind: "array", count: { ref: pick(rng, uints) }, element: genElement(rng, selfIdx, nTypes, depth) };
    case "struct":
      return genStruct(rng, selfIdx, nTypes, depth + 1);
    case "ref":
      return { kind: "ref", name: `T${int(rng, selfIdx + 1, nTypes - 1)}` };
    default:
      throw new Error("unreachable");
  }
}

function genElement(rng: () => number, selfIdx: number, nTypes: number, depth: number): TypeNode {
  const options: string[] = ["uint", "bytesFixed", "arrayOfUint"];
  if (depth < 2) {
    options.push("struct");
  }
  if (selfIdx + 1 < nTypes) {
    options.push("ref");
  }
  switch (pick(rng, options)) {
    case "uint":
      return genUint(rng);
    case "bytesFixed":
      return { kind: "bytes", length: int(rng, 1, 6) };
    case "arrayOfUint":
      return { kind: "array", count: int(rng, 0, 3), element: { kind: "uint", bits: 8 } };
    case "struct":
      return genStruct(rng, selfIdx, nTypes, depth + 1);
    case "ref":
      return { kind: "ref", name: `T${int(rng, selfIdx + 1, nTypes - 1)}` };
    default:
      throw new Error("unreachable");
  }
}

/** 收集每个 struct 节点（按对象身份）被其字段类型树引用的字段名集合（不跨 struct 边界）。 */
function collectRefSets(schema: Schema): Map<TypeNode, Set<string>> {
  const types = schema.types;
  const map = new Map<TypeNode, Set<string>>();
  const seen = new Set<TypeNode>();

  const collectRefs = (node: TypeNode, set: Set<string>): void => {
    switch (node.kind) {
      case "bytes":
        if (typeof node.length === "object") {
          set.add(node.length.ref);
        }
        break;
      case "array":
        if (typeof node.count === "object") {
          set.add(node.count.ref);
        }
        collectRefs(node.element, set);
        break;
      default:
        break;
    }
  };

  const walk = (node: TypeNode): void => {
    switch (node.kind) {
      case "struct": {
        if (seen.has(node)) {
          return;
        }
        seen.add(node);
        const set = new Set<string>();
        for (const f of node.fields) {
          collectRefs(f.type, set);
        }
        map.set(node, set);
        for (const f of node.fields) {
          walk(f.type);
        }
        break;
      }
      case "array":
        walk(node.element);
        break;
      case "ref":
        walk(types[node.name] as TypeNode);
        break;
      default:
        break;
    }
  };

  for (const name of Object.keys(types)) {
    walk(types[name] as TypeNode);
  }
  return map;
}

/**
 * 按 schema 生成一份合法随机数据：被长度/计数引用的 uint 字段取小值（0..5），
 * 条件字段按条件求值决定是否写出。
 */
export function genData(schema: Schema, rng: () => number): Buffer {
  const refSets = collectRefSets(schema);
  const types = schema.types;
  const out: number[] = [];

  const writeUint = (v: number, bits: number, le: boolean): void => {
    const size = bits / 8;
    for (let i = 0; i < size; i++) {
      const shift = le ? i : size - 1 - i;
      out.push(Math.floor(v / 2 ** (8 * shift)) & 0xff);
    }
  };

  const randUint = (bits: number): number =>
    bits === 8 ? int(rng, 0, 0xff) : bits === 16 ? int(rng, 0, 0xffff) : Math.floor(rng() * 2 ** 32);

  const resolveLen = (expr: number | { ref: string }, values: ReadonlyMap<string, unknown>): number =>
    typeof expr === "number" ? expr : (values.get(expr.ref) as number);

  const genNode = (
    node: TypeNode,
    values: Map<string, unknown>,
    refSet: ReadonlySet<string>,
    fieldName: string | null
  ): unknown => {
    switch (node.kind) {
      case "uint": {
        const constrained = fieldName !== null && refSet.has(fieldName);
        const v = constrained ? int(rng, 0, 5) : randUint(node.bits);
        writeUint(v, node.bits, node.littleEndian === true);
        return v;
      }
      case "bytes": {
        const len = resolveLen(node.length, values);
        for (let i = 0; i < len; i++) {
          out.push(int(rng, 0, 255));
        }
        return undefined;
      }
      case "array": {
        const count = resolveLen(node.count, values);
        for (let i = 0; i < count; i++) {
          genNode(node.element, values, refSet, null);
        }
        return undefined;
      }
      case "struct": {
        genStruct(node);
        return undefined;
      }
      case "ref": {
        genNode(types[node.name] as TypeNode, new Map(), refSets.get(types[node.name] as TypeNode) ?? new Set(), null);
        return undefined;
      }
    }
  };

  const genStruct = (node: StructNode): void => {
    const values = new Map<string, unknown>();
    const refSet = refSets.get(node) ?? new Set<string>();
    for (const f of node.fields) {
      if (f.when && values.get(f.when.field) !== f.when.equals) {
        continue;
      }
      const v = genNode(f.type, values, refSet, f.name);
      values.set(f.name, v);
    }
  };

  genNode(types[schema.root] as TypeNode, new Map(), new Set(), null);
  return Buffer.from(out);
}
