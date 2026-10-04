// Seeded random format + data generator used by the differential tests.
// Produces a random (valid) format, random matching input bytes, and the
// expected parse result, so both implementations can be checked against an
// independent model.

import {
  Condition,
  CountSpec,
  ElementSpec,
  Field,
  Format,
  IntType,
  LengthSpec,
  StructDef,
} from "./format";

export interface Rng {
  next(): number;
  int(n: number): number; // uniform in [0, n)
  bool(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    bool: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

// ---------------------------------------------------------------------------
// Format generation
// ---------------------------------------------------------------------------

interface IntInfo {
  name: string;
  max: number;
}

const INT_CHOICES: readonly { type: IntType; max: number }[] = [
  { type: "uint8", max: 0xff },
  { type: "uint16le", max: 0xffff },
  { type: "uint16be", max: 0xffff },
  { type: "uint32le", max: 0xffffffff },
  { type: "uint32be", max: 0xffffffff },
];

function allInts(scopes: IntInfo[][]): IntInfo[] {
  const out: IntInfo[] = [];
  for (const s of scopes) out.push(...s);
  return out;
}

function withWhen<F extends Field>(field: F, when: Condition | undefined): F {
  if (when !== undefined) field.when = when;
  return field;
}

export function randomFormat(rng: Rng, maxDepth = 3): Format {
  return { root: randomStruct(rng, maxDepth, [], false) };
}

function randomStruct(
  rng: Rng,
  depth: number,
  scopes: IntInfo[][],
  inElement: boolean,
): StructDef {
  const local: IntInfo[] = [];
  const inner = [...scopes, local];
  const count = 1 + rng.int(5);
  const fields: Field[] = [];
  for (let i = 0; i < count; i += 1) {
    const field = randomField(rng, `d${depth}f${i}`, depth, inner, inElement);
    fields.push(field);
    if (field.when === undefined) {
      const choice = INT_CHOICES.find((c) => c.type === field.type);
      if (choice !== undefined) local.push({ name: field.name, max: choice.max });
    }
  }
  return { fields };
}

function randomWhen(rng: Rng, scopes: IntInfo[][]): Condition | undefined {
  const ints = allInts(scopes);
  if (ints.length === 0 || !rng.bool(0.35)) return undefined;
  const target = rng.pick(ints);
  const op = rng.pick(["eq", "ne", "lt", "gt"] as const);
  const cond: Condition = { ref: target.name };
  cond[op] = op === "eq" || op === "ne" ? rng.int(4) : rng.int(256);
  return cond;
}

function randomLength(rng: Rng, scopes: IntInfo[][], maxConst: number): LengthSpec {
  const refs = allInts(scopes).filter((t) => t.max <= 0xffff);
  if (refs.length > 0 && rng.bool(0.6)) {
    const target = rng.pick(refs);
    return { ref: target.name, scale: 1 + rng.int(3), offset: rng.int(3) };
  }
  return rng.int(maxConst + 1);
}

function randomCount(rng: Rng, scopes: IntInfo[][]): CountSpec {
  const refs = allInts(scopes).filter((t) => t.max <= 0xff);
  if (refs.length > 0 && rng.bool(0.5)) {
    return { ref: rng.pick(refs).name };
  }
  return rng.int(5);
}

function randomField(
  rng: Rng,
  name: string,
  depth: number,
  scopes: IntInfo[][],
  inElement: boolean,
): Field {
  const when = randomWhen(rng, scopes);
  const kinds =
    depth > 0
      ? ["int", "int", "int", "bytes", "bytes", "string", "array", "array", "struct", "struct"]
      : ["int", "int", "bytes", "string"];
  switch (rng.pick(kinds)) {
    case "int":
      return withWhen({ name, type: rng.pick(INT_CHOICES).type }, when);
    case "bytes":
      return withWhen(
        { name, type: "bytes", length: inElement ? rng.int(9) : randomLength(rng, scopes, 8) },
        when,
      );
    case "string":
      return withWhen(
        { name, type: "string", length: inElement ? rng.int(9) : randomLength(rng, scopes, 8) },
        when,
      );
    case "array":
      return withWhen(
        {
          name,
          type: "array",
          count: inElement ? rng.int(4) : randomCount(rng, scopes),
          element: randomElement(rng, depth - 1, scopes),
        },
        when,
      );
    default:
      return withWhen(
        { name, type: "struct", fields: randomStruct(rng, depth - 1, scopes, true).fields },
        when,
      );
  }
}

function randomElement(rng: Rng, depth: number, scopes: IntInfo[][]): ElementSpec {
  const kinds =
    depth > 0
      ? ["int", "int", "bytes", "string", "array", "struct"]
      : ["int", "bytes", "string"];
  switch (rng.pick(kinds)) {
    case "int":
      return { type: rng.pick(INT_CHOICES).type };
    case "bytes":
      return { type: "bytes", length: rng.int(9) };
    case "string":
      return { type: "string", length: rng.int(9) };
    case "array":
      return { type: "array", count: rng.int(4), element: randomElement(rng, depth - 1, scopes) };
    default:
      return { type: "struct", fields: randomStruct(rng, depth - 1, scopes, true).fields };
  }
}

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

export interface GeneratedCase {
  format: Format;
  data: Uint8Array;
  expected: Record<string, unknown>;
}

type ValScope = Map<string, unknown>;

export function generateCase(seed: number): GeneratedCase {
  const rng = makeRng(seed);
  const format = randomFormat(rng);
  const out: number[] = [];
  const expected = writeStruct(format.root as StructDef, rng, out, []);
  return { format, data: new Uint8Array(out), expected };
}

function lookupNum(scopes: ValScope[], name: string): number {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const v = scopes[i].get(name);
    if (typeof v === "number") return v;
  }
  throw new Error(`generator bug: missing reference "${name}"`);
}

function condHolds(cond: Condition, scopes: ValScope[]): boolean {
  const v = lookupNum(scopes, cond.ref);
  if (cond.eq !== undefined) return v === cond.eq;
  if (cond.ne !== undefined) return v !== cond.ne;
  if (cond.lt !== undefined) return v < cond.lt;
  if (cond.gt !== undefined) return v > cond.gt;
  throw new Error("generator bug: invalid condition");
}

function evalLen(spec: LengthSpec, scopes: ValScope[]): number {
  if (typeof spec === "number") return spec;
  return lookupNum(scopes, spec.ref) * (spec.scale ?? 1) + (spec.offset ?? 0);
}

function evalCnt(spec: CountSpec, scopes: ValScope[]): number {
  return typeof spec === "number" ? spec : lookupNum(scopes, spec.ref);
}

function maxOfInt(type: IntType): number {
  const choice = INT_CHOICES.find((c) => c.type === type);
  if (choice === undefined) throw new Error(`generator bug: bad int type ${type}`);
  return choice.max;
}

// Bias integer values so conditions referenced later are satisfied ~60% of
// the time, giving both branches of "when" good coverage.
function chooseInt(type: IntType, rng: Rng, bias: Condition | undefined): number {
  const max = maxOfInt(type);
  if (bias !== undefined && rng.bool(0.6)) {
    if (bias.eq !== undefined && bias.eq <= max) return bias.eq;
    if (bias.ne !== undefined && bias.ne <= max) {
      return (bias.ne + 1 + rng.int(max)) % (max + 1);
    }
    if (bias.lt !== undefined && bias.lt > 0) {
      return rng.int(Math.min(bias.lt, max + 1));
    }
    if (bias.gt !== undefined && bias.gt < max) {
      return bias.gt + 1 + rng.int(max - bias.gt);
    }
  }
  return rng.int(max + 1);
}

function writeInt(out: number[], type: IntType, value: number): void {
  switch (type) {
    case "uint8":
      out.push(value & 0xff);
      break;
    case "uint16le":
      out.push(value & 0xff, (value >>> 8) & 0xff);
      break;
    case "uint16be":
      out.push((value >>> 8) & 0xff, value & 0xff);
      break;
    case "uint32le":
      out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
      break;
    case "uint32be":
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      break;
  }
}

function writeStruct(
  def: StructDef,
  rng: Rng,
  out: number[],
  scopes: ValScope[],
): Record<string, unknown> {
  const scope: ValScope = new Map();
  scopes.push(scope);
  const model: Record<string, unknown> = {};
  const condTargets = new Map<string, Condition>();
  for (const f of def.fields) {
    if (f.when !== undefined && !condTargets.has(f.when.ref)) {
      condTargets.set(f.when.ref, f.when);
    }
  }
  for (const f of def.fields) {
    if (f.when !== undefined && !condHolds(f.when, scopes)) continue;
    const value = writeField(f, rng, out, scopes, condTargets.get(f.name));
    model[f.name] = value;
    scope.set(f.name, value);
  }
  scopes.pop();
  return model;
}

function writeField(
  field: Field,
  rng: Rng,
  out: number[],
  scopes: ValScope[],
  bias: Condition | undefined,
): unknown {
  switch (field.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be": {
      const value = chooseInt(field.type, rng, bias);
      writeInt(out, field.type, value);
      return value;
    }
    case "bytes": {
      const len = evalLen(field.length, scopes);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        bytes[i] = rng.int(256);
        out.push(bytes[i]);
      }
      return bytes;
    }
    case "string": {
      const len = evalLen(field.length, scopes);
      let s = "";
      for (let i = 0; i < len; i += 1) {
        const code = 97 + rng.int(26);
        s += String.fromCharCode(code);
        out.push(code);
      }
      return s;
    }
    case "array": {
      const count = evalCnt(field.count, scopes);
      const items: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        items.push(writeElement(field.element, rng, out, scopes));
      }
      return items;
    }
    case "struct":
      return writeStruct({ fields: field.fields }, rng, out, scopes);
    case "ref":
      throw new Error("generator does not emit named-definition references");
  }
}

function writeElement(
  el: ElementSpec,
  rng: Rng,
  out: number[],
  scopes: ValScope[],
): unknown {
  switch (el.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be": {
      const value = rng.int(maxOfInt(el.type) + 1);
      writeInt(out, el.type, value);
      return value;
    }
    case "bytes": {
      const len = evalLen(el.length, scopes);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        bytes[i] = rng.int(256);
        out.push(bytes[i]);
      }
      return bytes;
    }
    case "string": {
      const len = evalLen(el.length, scopes);
      let s = "";
      for (let i = 0; i < len; i += 1) {
        const code = 97 + rng.int(26);
        s += String.fromCharCode(code);
        out.push(code);
      }
      return s;
    }
    case "array": {
      const count = evalCnt(el.count, scopes);
      const items: unknown[] = [];
      for (let i = 0; i < count; i += 1) {
        items.push(writeElement(el.element, rng, out, scopes));
      }
      return items;
    }
    case "struct":
      return writeStruct({ fields: el.fields }, rng, out, scopes);
    case "ref":
      throw new Error("generator does not emit named-definition references");
  }
}
