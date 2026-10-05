import { Buffer } from "node:buffer";
import { compile } from "./compile.js";
import { Cursor } from "./cursor.js";
import { ParseError } from "./errors.js";
import { interpret } from "./interpret.js";

export type Engine = "compile" | "interpret";
export type CursorReader = (cursor: Cursor) => unknown;

/** 构造指定引擎的解析器。schema 非法时抛 SchemaError。 */
export function readerFor(input: unknown, engine: Engine = "compile"): CursorReader {
  return engine === "interpret" ? interpret(input) : compile(input);
}

export interface ParseSuccess {
  ok: true;
  value: unknown;
  /** 解析结束后的游标位置。 */
  offset: number;
}

export interface ParseFailure {
  ok: false;
  error: { code: "eof" | "overflow"; message: string; at: number };
  /** 出错后游标已恢复到结构起点。 */
  offset: number;
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * 解析数据。schema 非法抛 SchemaError；数据错误（eof/overflow）不抛出，
 * 返回 ok:false，offset 为恢复后的游标位置，error.at 为失败实际发生处。
 */
export function parse(
  input: unknown,
  data: Uint8Array,
  opts: { engine?: Engine; offset?: number } = {}
): ParseResult {
  const reader = readerFor(input, opts.engine ?? "compile");
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const cursor = new Cursor(buf, opts.offset ?? 0);
  try {
    const value = reader(cursor);
    return { ok: true, value, offset: cursor.offset };
  } catch (err) {
    if (err instanceof ParseError) {
      return {
        ok: false,
        error: { code: err.code, message: err.message, at: err.at },
        offset: cursor.offset,
      };
    }
    throw err;
  }
}

export { SchemaError, ParseError } from "./errors.js";
export { validateSchema } from "./validate.js";
export { MAX_LENGTH, MAX_DYNAMIC_ITEMS } from "./checked.js";
export type { Schema, TypeNode, FieldNode, LengthExpr } from "./schema.js";
