import { MAX_LENGTH } from "./checked.js";
import { SchemaError } from "./errors.js";
import type { Schema, TypeNode } from "./schema.js";

/**
 * 校验 schema：结构形状、长度/计数表达式、when 引用、命名类型引用、
 * 定义图循环拒绝、固定布局的静态尺寸溢出。非法定义抛 SchemaError。
 */
export function validateSchema(input: unknown): Schema {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SchemaError("schema must be a plain object");
  }
  const schema = input as Record<string, unknown>;
  if (typeof schema.root !== "string" || schema.root.length === 0) {
    throw new SchemaError("schema.root must be a non-empty string");
  }
  if (typeof schema.types !== "object" || schema.types === null || Array.isArray(schema.types)) {
    throw new SchemaError("schema.types must be a plain object mapping names to type nodes");
  }
  const types = schema.types as Record<string, unknown>;
  const names = Object.keys(types);
  if (names.length === 0) {
    throw new SchemaError("schema.types must define at least one named type");
  }
  if (!Object.hasOwn(types, schema.root)) {
    throw new SchemaError(`root type "${schema.root}" is not defined in schema.types`);
  }
  for (const name of names) {
    validateType(types[name], `types.${name}`, types, null);
  }
  rejectCycles(names, types);
  checkStaticSizes(names, types);
  return input as unknown as Schema;
}

function validateType(
  node: unknown,
  path: string,
  types: Record<string, unknown>,
  scope: readonly string[] | null
): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new SchemaError(`${path}: type node must be an object`);
  }
  const n = node as Record<string, unknown>;
  switch (n.kind) {
    case "uint": {
      if (n.bits !== 8 && n.bits !== 16 && n.bits !== 32) {
        throw new SchemaError(`${path}: uint bits must be 8, 16 or 32, got ${JSON.stringify(n.bits)}`);
      }
      if (n.littleEndian !== undefined && typeof n.littleEndian !== "boolean") {
        throw new SchemaError(`${path}: littleEndian must be a boolean`);
      }
      return;
    }
    case "bytes": {
      validateLength(n.length, `${path}.length`, scope, "bytes length");
      return;
    }
    case "array": {
      validateLength(n.count, `${path}.count`, scope, "array count");
      validateType(n.element, `${path}.element`, types, scope);
      return;
    }
    case "struct": {
      const fields = n.fields;
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new SchemaError(`${path}: struct.fields must be a non-empty array`);
      }
      const seen = new Set<string>();
      const uintScope: string[] = [];
      fields.forEach((f, i) => {
        const fp = `${path}.fields[${i}]`;
        if (typeof f !== "object" || f === null || Array.isArray(f)) {
          throw new SchemaError(`${fp}: field must be an object`);
        }
        const field = f as Record<string, unknown>;
        if (typeof field.name !== "string" || field.name.length === 0) {
          throw new SchemaError(`${fp}: field.name must be a non-empty string`);
        }
        if (seen.has(field.name)) {
          throw new SchemaError(`${fp}: duplicate field name "${field.name}"`);
        }
        seen.add(field.name);
        if (field.when !== undefined) {
          validateWhen(field.when, fp, uintScope);
        }
        validateType(field.type, `${fp}.type`, types, uintScope);
        const kind = (field.type as Record<string, unknown> | null)?.kind;
        if (kind === "uint" && field.when === undefined) {
          uintScope.push(field.name);
        }
      });
      return;
    }
    case "ref": {
      if (typeof n.name !== "string" || !Object.hasOwn(types, n.name)) {
        throw new SchemaError(`${path}: unknown type reference "${String(n.name)}"`);
      }
      return;
    }
    default:
      throw new SchemaError(`${path}: unknown kind ${JSON.stringify(n.kind)}`);
  }
}

function validateWhen(when: unknown, path: string, uintScope: readonly string[]): void {
  if (typeof when !== "object" || when === null || Array.isArray(when)) {
    throw new SchemaError(`${path}: when must be an object { "field": string, "equals": number }`);
  }
  const w = when as Record<string, unknown>;
  if (typeof w.field !== "string" || w.field.length === 0) {
    throw new SchemaError(`${path}: when.field must be a non-empty string`);
  }
  if (typeof w.equals !== "number" || !Number.isSafeInteger(w.equals)) {
    throw new SchemaError(`${path}: when.equals must be a safe integer`);
  }
  if (!uintScope.includes(w.field)) {
    throw new SchemaError(
      `${path}: when.field "${w.field}" must refer to an earlier unconditional uint field of the same struct`
    );
  }
}

function validateLength(
  expr: unknown,
  path: string,
  scope: readonly string[] | null,
  what: string
): void {
  if (typeof expr === "number") {
    if (!Number.isSafeInteger(expr) || expr < 0) {
      throw new SchemaError(`${path}: ${what} must be a non-negative safe integer`);
    }
    if (expr > MAX_LENGTH) {
      throw new SchemaError(`${path}: ${what} ${expr} exceeds maximum length ${MAX_LENGTH}`);
    }
    return;
  }
  if (typeof expr === "object" && expr !== null && !Array.isArray(expr)) {
    const ref = (expr as Record<string, unknown>).ref;
    if (typeof ref !== "string" || ref.length === 0) {
      throw new SchemaError(`${path}: ${what} ref must be a non-empty field name`);
    }
    if (scope === null || !scope.includes(ref)) {
      throw new SchemaError(
        `${path}: ${what} ref "${ref}" must refer to an earlier unconditional uint field of the enclosing struct`
      );
    }
    return;
  }
  throw new SchemaError(`${path}: ${what} must be a non-negative integer or { "ref": "<field>" }`);
}

/** 定义图循环拒绝：命名类型引用图中存在环时抛 SchemaError。 */
function rejectCycles(names: string[], types: Record<string, unknown>): void {
  const refs = new Map<string, string[]>();
  for (const name of names) {
    refs.set(name, collectRefs(types[name] as TypeNode));
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (name: string): void => {
    state.set(name, "visiting");
    stack.push(name);
    for (const next of refs.get(name) ?? []) {
      if (state.get(next) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(next)), next].join(" -> ");
        throw new SchemaError(`definition cycle detected: ${cycle}`);
      }
      if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(name, "done");
  };
  for (const name of names) {
    if (!state.has(name)) {
      visit(name);
    }
  }
}

function collectRefs(node: TypeNode, out: string[] = []): string[] {
  switch (node.kind) {
    case "ref":
      out.push(node.name);
      break;
    case "array":
      collectRefs(node.element, out);
      break;
    case "struct":
      for (const f of node.fields) {
        collectRefs(f.type, out);
      }
      break;
    default:
      break;
  }
  return out;
}

/** 固定布局的静态尺寸检查：固定长度/计数的乘积与求和溢出时拒绝该 schema。 */
function checkStaticSizes(names: string[], types: Record<string, unknown>): void {
  const memo = new Map<TypeNode, number | null>();
  const add = (a: number, b: number): number => {
    const s = a + b;
    if (s > MAX_LENGTH) {
      throw new SchemaError(`static size overflow: struct byte size ${a} + ${b} exceeds ${MAX_LENGTH}`);
    }
    return s;
  };
  const mul = (a: number, b: number): number => {
    const p = a * b;
    if (!Number.isSafeInteger(p) || p > MAX_LENGTH) {
      throw new SchemaError(`static size overflow: array byte size ${a} * ${b} exceeds ${MAX_LENGTH}`);
    }
    return p;
  };
  const sizeOf = (node: TypeNode): number | null => {
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
          const elem = sizeOf(node.element);
          size = elem === null ? null : mul(node.count, elem);
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
          const s = sizeOf(f.type);
          if (s === null) {
            fixed = false;
            break;
          }
          total = add(total, s);
        }
        size = fixed ? total : null;
        break;
      }
      case "ref":
        size = sizeOf(types[node.name] as TypeNode);
        break;
    }
    memo.set(node, size);
    return size;
  };
  for (const name of names) {
    sizeOf(types[name] as TypeNode);
  }
}
