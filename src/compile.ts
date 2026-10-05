import { Buffer } from "node:buffer";
import { checkArray, checkLength } from "./checked.js";
import { Cursor } from "./cursor.js";
import { ParseError, SchemaError } from "./errors.js";
import type { Schema, TypeNode } from "./schema.js";
import { validateSchema } from "./validate.js";

type Reader = (cursor: Cursor, scope: readonly unknown[]) => unknown;

interface Compiled {
  read: Reader;
  staticSize: number | null;
}

const EMPTY_SCOPE: readonly unknown[] = [];

/**
 * 编译式解析器（主引擎）：校验后把每个命名类型编译为闭包，
 * 引用解析为字段下标、静态尺寸预计算，运行时不再查表。
 * struct/array 解析失败时游标恢复到该结构起点。
 */
export function compile(input: unknown): (cursor: Cursor) => unknown {
  const schema: Schema = validateSchema(input);
  const named = new Map<string, Compiled>();

  function compileNamed(name: string): Compiled {
    let hit = named.get(name);
    if (!hit) {
      hit = compileNode(schema.types[name] as TypeNode, null);
      named.set(name, hit);
    }
    return hit;
  }

  function needIndex(scopeIndex: Map<string, number> | null, ref: string): number {
    const idx = scopeIndex?.get(ref);
    if (idx === undefined) {
      throw new SchemaError(`internal: unresolved field reference "${ref}"`);
    }
    return idx;
  }

  function readBytes(cursor: Cursor, len: number): Buffer {
    const at = cursor.offset;
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

  function compileNode(node: TypeNode, scopeIndex: Map<string, number> | null): Compiled {
    switch (node.kind) {
      case "uint": {
        const size = node.bits / 8;
        const bits = node.bits;
        const le = node.littleEndian === true;
        return {
          staticSize: size,
          read(cursor) {
            const at = cursor.offset;
            if (at + size > cursor.buf.length) {
              throw new ParseError(
                "eof",
                at,
                `uint${bits} needs ${size} byte(s) at offset ${at}, only ${cursor.buf.length - at} remain`
              );
            }
            const buf = cursor.buf;
            const v =
              bits === 8
                ? buf.readUInt8(at)
                : bits === 16
                  ? le
                    ? buf.readUInt16LE(at)
                    : buf.readUInt16BE(at)
                  : le
                    ? buf.readUInt32LE(at)
                    : buf.readUInt32BE(at);
            cursor.offset = at + size;
            return v;
          },
        };
      }
      case "bytes": {
        if (typeof node.length === "number") {
          const len = node.length;
          return { staticSize: len, read: (cursor) => readBytes(cursor, len) };
        }
        const ref = node.length.ref;
        const idx = needIndex(scopeIndex, ref);
        return {
          staticSize: null,
          read: (cursor, scope) =>
            readBytes(cursor, checkLength(scope[idx], cursor.offset, `bytes length (ref "${ref}")`)),
        };
      }
      case "array": {
        const elem = compileNode(node.element, scopeIndex);
        const elemStatic = elem.staticSize;
        const fixedCount = typeof node.count === "number" ? node.count : null;
        const countIdx = fixedCount === null ? needIndex(scopeIndex, (node.count as { ref: string }).ref) : -1;
        return {
          staticSize: fixedCount !== null && elemStatic !== null ? fixedCount * elemStatic : null,
          read(cursor, scope) {
            const at = cursor.offset;
            const count = fixedCount !== null ? fixedCount : (scope[countIdx] as number);
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
              const out = new Array<unknown>(count);
              for (let i = 0; i < count; i++) {
                out[i] = elem.read(cursor, scope);
              }
              return out;
            } catch (err) {
              cursor.offset = start;
              throw err;
            }
          },
        };
      }
      case "struct": {
        const fields = node.fields;
        const index = new Map<string, number>();
        fields.forEach((f, i) => index.set(f.name, i));
        const plans = fields.map((f) => ({
          name: f.name,
          whenIdx: f.when ? needIndex(index, f.when.field) : -1,
          whenEquals: f.when ? f.when.equals : 0,
          compiled: compileNode(f.type, index),
        }));
        let staticSize: number | null = 0;
        for (const p of plans) {
          if (staticSize === null || p.whenIdx >= 0 || p.compiled.staticSize === null) {
            staticSize = null;
          } else {
            staticSize += p.compiled.staticSize;
          }
        }
        return {
          staticSize,
          read(cursor) {
            const start = cursor.offset;
            const values = new Array<unknown>(plans.length);
            const out: Record<string, unknown> = {};
            try {
              for (let i = 0; i < plans.length; i++) {
                const p = plans[i]!;
                if (p.whenIdx >= 0 && values[p.whenIdx] !== p.whenEquals) {
                  continue;
                }
                const v = p.compiled.read(cursor, values);
                values[i] = v;
                out[p.name] = v;
              }
              return out;
            } catch (err) {
              cursor.offset = start;
              throw err;
            }
          },
        };
      }
      case "ref": {
        const target = compileNamed(node.name);
        return {
          staticSize: target.staticSize,
          read: (cursor, scope) => target.read(cursor, scope),
        };
      }
    }
  }

  const root = compileNamed(schema.root);
  return (cursor: Cursor) => root.read(cursor, EMPTY_SCOPE);
}
