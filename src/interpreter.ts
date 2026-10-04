// Direct format interpreter: an independent, non-compiling implementation
// that walks the raw format description and threads the read position
// explicitly through the call tree (no shared cursor, no plan objects).
// It exists to cross-check the compiling parser in differential tests.

import {
  Condition,
  CountSpec,
  ElementSpec,
  Field,
  Format,
  INT_SIZES,
  IntType,
  LengthSpec,
  MAX_COUNT,
  MAX_LENGTH,
  StructDef,
} from "./format";

export class InterpretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterpretError";
  }
}

type Scope = Map<string, unknown>;

interface Ctx {
  buf: Uint8Array;
  view: DataView;
  defs: Record<string, StructDef>;
}

const utf8 = new TextDecoder("utf-8");

export function interpret(
  format: Format,
  buf: Uint8Array,
): { value: Record<string, unknown>; bytesRead: number } {
  const defs = format.definitions ?? {};
  const root = typeof format.root === "string" ? defs[format.root] : format.root;
  if (root === null || typeof root !== "object" || !Array.isArray(root.fields)) {
    throw new InterpretError("invalid root definition");
  }
  const ctx: Ctx = {
    buf,
    view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
    defs,
  };
  const [value, pos] = readStruct(ctx, root, 0, []);
  return { value, bytesRead: pos };
}

function need(ctx: Ctx, pos: number, n: number): void {
  if (pos + n > ctx.buf.length) {
    throw new InterpretError(
      `unexpected end of input: need ${n} bytes at offset ${pos}, have ${ctx.buf.length - pos}`,
    );
  }
}

function refValue(scopes: Scope[], name: string): number {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const v = scopes[i].get(name);
    if (typeof v === "number") return v;
    if (v !== undefined) {
      throw new InterpretError(`reference "${name}" is not an integer`);
    }
  }
  throw new InterpretError(`unknown reference "${name}"`);
}

function condHolds(scopes: Scope[], cond: Condition): boolean {
  const v = refValue(scopes, cond.ref);
  if (cond.eq !== undefined) return v === cond.eq;
  if (cond.ne !== undefined) return v !== cond.ne;
  if (cond.lt !== undefined) return v < cond.lt;
  if (cond.gt !== undefined) return v > cond.gt;
  throw new InterpretError("invalid condition: need one of eq/ne/lt/gt");
}

function evalLength(scopes: Scope[], spec: LengthSpec): number {
  if (typeof spec === "number") {
    if (!Number.isInteger(spec) || spec < 0 || spec > MAX_LENGTH) {
      throw new InterpretError(`constant length ${spec} out of range`);
    }
    return spec;
  }
  const base = refValue(scopes, spec.ref);
  const scale = spec.scale ?? 1;
  const offset = spec.offset ?? 0;
  const product = base * scale;
  if (!Number.isSafeInteger(product)) {
    throw new InterpretError(`length overflow: ${base} * ${scale}`);
  }
  const total = product + offset;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new InterpretError(`length out of range: ${total}`);
  }
  if (total > MAX_LENGTH) {
    throw new InterpretError(`length ${total} exceeds limit ${MAX_LENGTH}`);
  }
  return total;
}

function evalCount(scopes: Scope[], spec: CountSpec): number {
  const count = typeof spec === "number" ? spec : refValue(scopes, spec.ref);
  if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT) {
    throw new InterpretError(`array count ${count} out of range`);
  }
  return count;
}

function readStruct(
  ctx: Ctx,
  def: StructDef,
  pos: number,
  scopes: Scope[],
): [Record<string, unknown>, number] {
  const scope: Scope = new Map();
  scopes.push(scope);
  try {
    const out: Record<string, unknown> = {};
    let cur = pos;
    for (const field of def.fields) {
      if (field.when !== undefined && !condHolds(scopes, field.when)) continue;
      const [value, next] = readField(ctx, field, cur, scopes);
      cur = next;
      out[field.name] = value;
      scope.set(field.name, value);
    }
    return [out, cur];
  } finally {
    scopes.pop();
  }
}

function readField(
  ctx: Ctx,
  field: Field,
  pos: number,
  scopes: Scope[],
): [unknown, number] {
  switch (field.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be":
      return readInt(ctx, field.type, pos);
    case "bytes": {
      const n = evalLength(scopes, field.length);
      need(ctx, pos, n);
      return [ctx.buf.subarray(pos, pos + n), pos + n];
    }
    case "string": {
      const n = evalLength(scopes, field.length);
      need(ctx, pos, n);
      return [utf8.decode(ctx.buf.subarray(pos, pos + n)), pos + n];
    }
    case "array": {
      const count = evalCount(scopes, field.count);
      return readArray(ctx, field.element, count, pos, scopes);
    }
    case "struct":
      return readStruct(ctx, { fields: field.fields }, pos, scopes);
    case "ref": {
      const def = ctx.defs[field.ref];
      if (def === undefined) {
        throw new InterpretError(`unknown definition "${field.ref}"`);
      }
      return readStruct(ctx, def, pos, scopes);
    }
  }
}

function readElement(
  ctx: Ctx,
  el: ElementSpec,
  pos: number,
  scopes: Scope[],
): [unknown, number] {
  switch (el.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be":
      return readInt(ctx, el.type, pos);
    case "bytes": {
      const n = evalLength(scopes, el.length);
      need(ctx, pos, n);
      return [ctx.buf.subarray(pos, pos + n), pos + n];
    }
    case "string": {
      const n = evalLength(scopes, el.length);
      need(ctx, pos, n);
      return [utf8.decode(ctx.buf.subarray(pos, pos + n)), pos + n];
    }
    case "array": {
      const count = evalCount(scopes, el.count);
      return readArray(ctx, el.element, count, pos, scopes);
    }
    case "struct":
      return readStruct(ctx, { fields: el.fields }, pos, scopes);
    case "ref": {
      const def = ctx.defs[el.ref];
      if (def === undefined) {
        throw new InterpretError(`unknown definition "${el.ref}"`);
      }
      return readStruct(ctx, def, pos, scopes);
    }
  }
}

function readArray(
  ctx: Ctx,
  el: ElementSpec,
  count: number,
  pos: number,
  scopes: Scope[],
): [unknown[], number] {
  const out: unknown[] = [];
  let cur = pos;
  for (let i = 0; i < count; i += 1) {
    const [value, next] = readElement(ctx, el, cur, scopes);
    cur = next;
    out.push(value);
  }
  return [out, cur];
}

function readInt(ctx: Ctx, type: IntType, pos: number): [number, number] {
  const size = INT_SIZES[type];
  need(ctx, pos, size);
  switch (type) {
    case "uint8":
      return [ctx.view.getUint8(pos), pos + 1];
    case "uint16le":
      return [ctx.view.getUint16(pos, true), pos + 2];
    case "uint16be":
      return [ctx.view.getUint16(pos, false), pos + 2];
    case "uint32le":
      return [ctx.view.getUint32(pos, true), pos + 4];
    case "uint32be":
      return [ctx.view.getUint32(pos, false), pos + 4];
  }
}
