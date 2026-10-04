// Compiling parser: validates a format, compiles it to a plan in which every
// named reference is resolved to a static frame slot, then executes the plan
// against a byte buffer with a single mutable cursor.
//
// Error semantics: if parsing a struct fails, the cursor is restored to the
// offset where that struct began before the error propagates.
//
// Overflow safety: every length/count multiplication is checked against
// Number.MAX_SAFE_INTEGER and against MAX_LENGTH / MAX_COUNT limits, and
// fixed-size arrays are pre-flighted against the remaining input.

import {
  Condition,
  CountSpec,
  ElementSpec,
  Field,
  Format,
  FormatError,
  INT_SIZES,
  IntType,
  LengthSpec,
  MAX_COUNT,
  MAX_LENGTH,
  StructDef,
  isIntType,
  validateFormat,
} from "./format";

export class ParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = "ParseError";
    this.offset = offset;
  }
}

interface FrameRef {
  up: number; // how many frames above the current one
  slot: number; // field index within that frame
}

type CompiledLength =
  | { kind: "const"; value: number }
  | { kind: "ref"; ref: FrameRef; scale: number; offset: number };

type CompiledCount =
  | { kind: "const"; value: number }
  | { kind: "ref"; ref: FrameRef };

interface CompiledCond {
  ref: FrameRef;
  op: "eq" | "ne" | "lt" | "gt";
  value: number;
}

export type Plan =
  | { kind: "int"; intType: IntType; size: number }
  | { kind: "bytes"; length: CompiledLength }
  | { kind: "string"; length: CompiledLength }
  | { kind: "array"; count: CompiledCount; element: Plan }
  | { kind: "struct"; fields: FieldPlan[] };

export interface FieldPlan {
  name: string;
  cond: CompiledCond | null;
  plan: Plan;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

type CompileScope = Map<string, number>; // referenceable int field name -> slot

function resolveRef(scopes: CompileScope[], name: string): FrameRef {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const slot = scopes[i].get(name);
    if (slot !== undefined) return { up: scopes.length - 1 - i, slot };
  }
  throw new FormatError(`internal: unresolved reference "${name}"`);
}

function compileCond(cond: Condition, scopes: CompileScope[]): CompiledCond {
  const ops = ["eq", "ne", "lt", "gt"] as const;
  for (const op of ops) {
    const value = cond[op];
    if (value !== undefined) {
      return { ref: resolveRef(scopes, cond.ref), op, value };
    }
  }
  throw new FormatError("internal: invalid condition");
}

function compileLength(spec: LengthSpec, scopes: CompileScope[]): CompiledLength {
  if (typeof spec === "number") return { kind: "const", value: spec };
  return {
    kind: "ref",
    ref: resolveRef(scopes, spec.ref),
    scale: spec.scale ?? 1,
    offset: spec.offset ?? 0,
  };
}

function compileCount(spec: CountSpec, scopes: CompileScope[]): CompiledCount {
  if (typeof spec === "number") return { kind: "const", value: spec };
  return { kind: "ref", ref: resolveRef(scopes, spec.ref) };
}

function fixedSizeOf(plan: Plan): number | null {
  switch (plan.kind) {
    case "int":
      return plan.size;
    case "bytes":
    case "string":
      return plan.length.kind === "const" ? plan.length.value : null;
    case "array": {
      if (plan.count.kind !== "const") return null;
      const inner = fixedSizeOf(plan.element);
      if (inner === null) return null;
      const total = plan.count.value * inner;
      return Number.isSafeInteger(total) ? total : null;
    }
    case "struct": {
      let total = 0;
      for (const f of plan.fields) {
        if (f.cond !== null) return null;
        const s = fixedSizeOf(f.plan);
        if (s === null) return null;
        total += s;
        if (!Number.isSafeInteger(total)) return null;
      }
      return total;
    }
  }
}

type ArrayPlan = Extract<Plan, { kind: "array" }>;

function compileArray(
  count: CountSpec,
  element: ElementSpec,
  scopes: CompileScope[],
  defs: Record<string, StructDef>,
  defPlans: Map<string, Plan>,
): ArrayPlan {
  return {
    kind: "array",
    count: compileCount(count, scopes),
    element: compileElement(element, scopes, defs, defPlans),
  };
}

function compileElement(
  el: ElementSpec,
  scopes: CompileScope[],
  defs: Record<string, StructDef>,
  defPlans: Map<string, Plan>,
): Plan {
  switch (el.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be":
      return { kind: "int", intType: el.type, size: INT_SIZES[el.type] };
    case "bytes":
      return { kind: "bytes", length: compileLength(el.length, scopes) };
    case "string":
      return { kind: "string", length: compileLength(el.length, scopes) };
    case "array":
      return compileArray(el.count, el.element, scopes, defs, defPlans);
    case "struct":
      return { kind: "struct", fields: compileFields(el.fields, scopes, defs, defPlans) };
    case "ref":
      return compileDefPlan(el.ref, defs, defPlans);
  }
}

function compileField(
  field: Field,
  scopes: CompileScope[],
  defs: Record<string, StructDef>,
  defPlans: Map<string, Plan>,
): Plan {
  switch (field.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be":
      return { kind: "int", intType: field.type, size: INT_SIZES[field.type] };
    case "bytes":
      return { kind: "bytes", length: compileLength(field.length, scopes) };
    case "string":
      return { kind: "string", length: compileLength(field.length, scopes) };
    case "array":
      return compileArray(field.count, field.element, scopes, defs, defPlans);
    case "struct":
      return {
        kind: "struct",
        fields: compileFields(field.fields, scopes, defs, defPlans),
      };
    case "ref":
      return compileDefPlan(field.ref, defs, defPlans);
  }
}

function compileFields(
  fields: Field[],
  scopes: CompileScope[],
  defs: Record<string, StructDef>,
  defPlans: Map<string, Plan>,
): FieldPlan[] {
  const local: CompileScope = new Map();
  const inner = [...scopes, local];
  return fields.map((field, index) => {
    const cond = field.when ? compileCond(field.when, inner) : null;
    const plan = compileField(field, inner, defs, defPlans);
    if (isIntType(field.type) && field.when === undefined) {
      local.set(field.name, index);
    }
    return { name: field.name, cond, plan };
  });
}

function compileDefPlan(
  name: string,
  defs: Record<string, StructDef>,
  defPlans: Map<string, Plan>,
): Plan {
  let plan = defPlans.get(name);
  if (plan === undefined) {
    // Definitions are closed: they compile against an empty outer scope and
    // are acyclic (validated), so plain memoized recursion terminates.
    plan = { kind: "struct", fields: compileFields(defs[name].fields, [], defs, defPlans) };
    defPlans.set(name, plan);
  }
  return plan;
}

export function compileFormat(format: Format): Plan {
  validateFormat(format);
  const defs = format.definitions ?? {};
  const defPlans = new Map<string, Plan>();
  if (typeof format.root === "string") {
    return compileDefPlan(format.root, defs, defPlans);
  }
  return { kind: "struct", fields: compileFields(format.root.fields, [], defs, defPlans) };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder("utf-8");

export class Parser {
  offset = 0;
  private readonly view: DataView;
  private readonly frames: unknown[][] = [];

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  run(plan: Plan): Record<string, unknown> {
    if (plan.kind !== "struct") {
      throw new FormatError("root plan must be a struct");
    }
    return this.execStruct(plan);
  }

  private execStruct(
    plan: Extract<Plan, { kind: "struct" }>,
  ): Record<string, unknown> {
    const start = this.offset;
    const frame: unknown[] = [];
    this.frames.push(frame);
    const out: Record<string, unknown> = {};
    try {
      for (const f of plan.fields) {
        let value: unknown = undefined;
        if (f.cond === null || this.evalCond(f.cond)) {
          value = this.exec(f.plan);
          out[f.name] = value;
        }
        frame.push(value); // keep slot indices aligned with compile time
      }
      return out;
    } catch (err) {
      this.offset = start; // restore cursor to the structure start
      throw err;
    } finally {
      this.frames.pop();
    }
  }

  private exec(plan: Plan): unknown {
    switch (plan.kind) {
      case "int":
        return this.readInt(plan.intType, plan.size);
      case "bytes":
        return this.readBytes(this.resolveLength(plan.length));
      case "string":
        return utf8.decode(this.readBytes(this.resolveLength(plan.length)));
      case "array":
        return this.execArray(plan);
      case "struct":
        return this.execStruct(plan);
    }
  }

  private execArray(plan: ArrayPlan): unknown[] {
    const count = this.resolveCount(plan.count);
    const elemSize = fixedSizeOf(plan.element);
    if (elemSize !== null) {
      const need = count * elemSize;
      if (!Number.isSafeInteger(need)) {
        throw new ParseError(
          `array size overflow: ${count} * ${elemSize} exceeds safe integer range`,
          this.offset,
        );
      }
      if (need > this.buf.length - this.offset) {
        throw new ParseError(
          `array of ${count} x ${elemSize} bytes exceeds remaining input (${this.buf.length - this.offset} bytes)`,
          this.offset,
        );
      }
    }
    const out: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(this.exec(plan.element));
    }
    return out;
  }

  private readFrameValue(ref: FrameRef): number {
    const frame = this.frames[this.frames.length - 1 - ref.up];
    const value = frame[ref.slot];
    if (typeof value !== "number") {
      throw new ParseError("internal: referenced slot is not a number", this.offset);
    }
    return value;
  }

  private evalCond(cond: CompiledCond): boolean {
    const v = this.readFrameValue(cond.ref);
    switch (cond.op) {
      case "eq":
        return v === cond.value;
      case "ne":
        return v !== cond.value;
      case "lt":
        return v < cond.value;
      case "gt":
        return v > cond.value;
    }
  }

  private resolveLength(len: CompiledLength): number {
    if (len.kind === "const") return len.value;
    const base = this.readFrameValue(len.ref);
    const product = base * len.scale;
    if (!Number.isSafeInteger(product)) {
      throw new ParseError(
        `length overflow: ${base} * ${len.scale} exceeds safe integer range`,
        this.offset,
      );
    }
    const total = product + len.offset;
    if (!Number.isSafeInteger(total)) {
      throw new ParseError(
        `length overflow: ${base} * ${len.scale} + ${len.offset} exceeds safe integer range`,
        this.offset,
      );
    }
    if (total < 0) {
      throw new ParseError(`negative length ${total}`, this.offset);
    }
    if (total > MAX_LENGTH) {
      throw new ParseError(`length ${total} exceeds limit ${MAX_LENGTH}`, this.offset);
    }
    return total;
  }

  private resolveCount(spec: CompiledCount): number {
    const count = spec.kind === "const" ? spec.value : this.readFrameValue(spec.ref);
    if (!Number.isInteger(count) || count < 0) {
      throw new ParseError(`invalid array count ${count}`, this.offset);
    }
    if (count > MAX_COUNT) {
      throw new ParseError(
        `array count ${count} exceeds limit ${MAX_COUNT}`,
        this.offset,
      );
    }
    return count;
  }

  private readInt(intType: IntType, size: number): number {
    const at = this.offset;
    if (at + size > this.buf.length) {
      throw new ParseError(
        `unexpected end of input: need ${size} bytes at offset ${at}, have ${this.buf.length - at}`,
        at,
      );
    }
    let value: number;
    switch (intType) {
      case "uint8":
        value = this.view.getUint8(at);
        break;
      case "uint16le":
        value = this.view.getUint16(at, true);
        break;
      case "uint16be":
        value = this.view.getUint16(at, false);
        break;
      case "uint32le":
        value = this.view.getUint32(at, true);
        break;
      case "uint32be":
        value = this.view.getUint32(at, false);
        break;
      default:
        throw new ParseError(`unknown int type ${String(intType)}`, at);
    }
    this.offset = at + size;
    return value;
  }

  private readBytes(n: number): Uint8Array {
    const at = this.offset;
    if (at + n > this.buf.length) {
      throw new ParseError(
        `unexpected end of input: need ${n} bytes at offset ${at}, have ${this.buf.length - at}`,
        at,
      );
    }
    this.offset = at + n;
    return this.buf.subarray(at, at + n);
  }
}

export function parseBuffer(
  format: Format,
  buf: Uint8Array,
): { value: Record<string, unknown>; bytesRead: number } {
  const plan = compileFormat(format);
  const parser = new Parser(buf);
  const value = parser.run(plan);
  return { value, bytesRead: parser.offset };
}
