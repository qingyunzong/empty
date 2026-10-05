import { Buffer } from "node:buffer";
import { checkArray, checkLength } from "./checked.js";
import { Cursor } from "./cursor.js";
import { ParseError, SchemaError } from "./errors.js";
import type { LengthExpr, Schema, TypeNode } from "./schema.js";
import { staticSizeOf } from "./size.js";
import { validateSchema } from "./validate.js";

/**
 * 直接格式解释器（参照引擎）：不预编译，逐节点遍历 schema 树，
 * 命名类型与字段引用在解析时现查。用于与编译式解析器做差分核对。
 * struct/array 解析失败时游标恢复到该结构起点。
 */
export function interpret(input: unknown): (cursor: Cursor) => unknown {
  const schema: Schema = validateSchema(input);
  const types = schema.types;

  function resolveLen(expr: LengthExpr, scope: ReadonlyMap<string, unknown>, at: number, what: string): number {
    return typeof expr === "number" ? expr : checkLength(scope.get(expr.ref), at, `${what} (ref "${expr.ref}")`);
  }

  function readNode(node: TypeNode, cursor: Cursor, scope: ReadonlyMap<string, unknown>): unknown {
    switch (node.kind) {
      case "uint": {
        const size = node.bits / 8;
        const at = cursor.offset;
        if (at + size > cursor.buf.length) {
          throw new ParseError(
            "eof",
            at,
            `uint${node.bits} needs ${size} byte(s) at offset ${at}, only ${cursor.buf.length - at} remain`
          );
        }
        const buf = cursor.buf;
        const v =
          node.bits === 8
            ? buf.readUInt8(at)
            : node.bits === 16
              ? node.littleEndian
                ? buf.readUInt16LE(at)
                : buf.readUInt16BE(at)
              : node.littleEndian
                ? buf.readUInt32LE(at)
                : buf.readUInt32BE(at);
        cursor.offset = at + size;
        return v;
      }
      case "bytes": {
        const at = cursor.offset;
        const len = resolveLen(node.length, scope, at, "bytes length");
        if (at + len > cursor.buf.length) {
          throw new ParseError(
            "eof",
            at,
            `bytes(${len}) at offset ${at} exceeds buffer (${cursor.buf.length - at} byte(s) remain)`
          );
        }
        const out = cursor.buf.subarray(at, at + len);
        cursor.offset = at + len;
        return out;
      }
      case "array": {
        const at = cursor.offset;
        const count = resolveLen(node.count, scope, at, "array count");
        const elemStatic = staticSizeOf(node.element, types);
        const total = checkArray(count, elemStatic, at);
        if (total >= 0 && at + total > cursor.buf.length) {
          throw new ParseError(
            "eof",
            at,
            `array of ${count} x ${elemStatic} byte(s) at offset ${at} exceeds buffer (${cursor.buf.length - at} byte(s) remain)`
          );
        }
        const start = cursor.offset;
        try {
          const out: unknown[] = [];
          for (let i = 0; i < count; i++) {
            out.push(readNode(node.element, cursor, scope));
          }
          return out;
        } catch (err) {
          cursor.offset = start;
          throw err;
        }
      }
      case "struct": {
        const start = cursor.offset;
        const local = new Map<string, unknown>();
        const out: Record<string, unknown> = {};
        try {
          for (const field of node.fields) {
            if (field.when && local.get(field.when.field) !== field.when.equals) {
              continue;
            }
            const v = readNode(field.type, cursor, local);
            local.set(field.name, v);
            out[field.name] = v;
          }
          return out;
        } catch (err) {
          cursor.offset = start;
          throw err;
        }
      }
      case "ref": {
        const target = types[node.name];
        if (!target) {
          throw new SchemaError(`unknown type reference "${node.name}"`);
        }
        return readNode(target, cursor, scope);
      }
    }
  }

  return (cursor: Cursor) => readNode(schema.types[schema.root] as TypeNode, cursor, new Map());
}
