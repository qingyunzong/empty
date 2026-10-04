// Format description types and validation.
//
// A format is a JSON-friendly description of a binary structure:
//   - integer fields (uint8/16/32, little/big endian)
//   - bytes / string fields whose length may reference a previous integer
//     field, optionally scaled and offset: { "ref": "n", "scale": 4, "offset": 1 }
//   - arrays with a constant count or a count taken from a previous field,
//     whose element may itself be an array (nested arrays) or a struct
//   - inline structs and references to named definitions
//   - conditional presence via "when": { "ref": "tag", "eq": 1 }
//
// Validation rejects: definition-graph cycles, unknown/forward references,
// references to non-integer or conditional fields, and out-of-range constants.

export const MAX_LENGTH = 1 << 30; // 1 GiB cap for a single byte/string field
export const MAX_COUNT = 1 << 20; // cap for a single array's element count

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

export type IntType = "uint8" | "uint16le" | "uint16be" | "uint32le" | "uint32be";

export function isIntType(type: string): type is IntType {
  return (
    type === "uint8" ||
    type === "uint16le" ||
    type === "uint16be" ||
    type === "uint32le" ||
    type === "uint32be"
  );
}

export const INT_SIZES: Record<IntType, number> = {
  uint8: 1,
  uint16le: 2,
  uint16be: 2,
  uint32le: 4,
  uint32be: 4,
};

export interface Condition {
  ref: string;
  eq?: number;
  ne?: number;
  lt?: number;
  gt?: number;
}

export type LengthSpec = number | { ref: string; scale?: number; offset?: number };
export type CountSpec = number | { ref: string };

interface BaseField {
  name: string;
  when?: Condition;
}

export interface IntField extends BaseField {
  type: IntType;
}
export interface BytesField extends BaseField {
  type: "bytes";
  length: LengthSpec;
}
export interface StringField extends BaseField {
  type: "string";
  length: LengthSpec;
}
export interface ArrayField extends BaseField {
  type: "array";
  count: CountSpec;
  element: ElementSpec;
}
export interface StructField extends BaseField {
  type: "struct";
  fields: Field[];
}
export interface RefField extends BaseField {
  type: "ref";
  ref: string;
}

export type Field =
  | IntField
  | BytesField
  | StringField
  | ArrayField
  | StructField
  | RefField;

export type ElementSpec =
  | { type: IntType }
  | { type: "bytes"; length: LengthSpec }
  | { type: "string"; length: LengthSpec }
  | { type: "array"; count: CountSpec; element: ElementSpec }
  | { type: "struct"; fields: Field[] }
  | { type: "ref"; ref: string };

export interface StructDef {
  fields: Field[];
}

export interface Format {
  definitions?: Record<string, StructDef>;
  root: StructDef | string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// "int" marks fields that may be referenced (preceding unconditional integers);
// everything else is visible only for duplicate-name checking.
type RefKind = "int" | "other";
type Scope = Map<string, RefKind>;

function lookup(scopes: Scope[], name: string): RefKind | undefined {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const kind = scopes[i].get(name);
    if (kind !== undefined) return kind;
  }
  return undefined;
}

function requireIntRef(scopes: Scope[], name: string, path: string): void {
  const kind = lookup(scopes, name);
  if (kind === undefined) {
    throw new FormatError(
      `${path}: unknown field reference "${name}" (only preceding fields are visible)`,
    );
  }
  if (kind !== "int") {
    throw new FormatError(
      `${path}: reference "${name}" does not denote a preceding unconditional integer field`,
    );
  }
}

const CONDITION_OPS = ["eq", "ne", "lt", "gt"] as const;

function validateCondition(cond: Condition, scopes: Scope[], path: string): void {
  if (cond === null || typeof cond !== "object") {
    throw new FormatError(`${path}: condition must be an object`);
  }
  const ops = CONDITION_OPS.filter((op) => cond[op] !== undefined);
  if (ops.length !== 1) {
    throw new FormatError(`${path}: condition needs exactly one of eq/ne/lt/gt`);
  }
  const value = cond[ops[0]] as number;
  if (!Number.isInteger(value)) {
    throw new FormatError(`${path}: condition value must be an integer`);
  }
  requireIntRef(scopes, cond.ref, path);
}

function validateLength(spec: LengthSpec, scopes: Scope[], path: string): void {
  if (typeof spec === "number") {
    if (!Number.isInteger(spec) || spec < 0 || spec > MAX_LENGTH) {
      throw new FormatError(
        `${path}: constant length must be an integer in [0, ${MAX_LENGTH}]`,
      );
    }
    return;
  }
  if (spec === null || typeof spec !== "object") {
    throw new FormatError(`${path}: invalid length spec`);
  }
  requireIntRef(scopes, spec.ref, path);
  const scale = spec.scale ?? 1;
  const offset = spec.offset ?? 0;
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new FormatError(`${path}: scale must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(offset)) {
    throw new FormatError(`${path}: offset must be a safe integer`);
  }
}

function validateCount(spec: CountSpec, scopes: Scope[], path: string): void {
  if (typeof spec === "number") {
    if (!Number.isInteger(spec) || spec < 0 || spec > MAX_COUNT) {
      throw new FormatError(
        `${path}: constant count must be an integer in [0, ${MAX_COUNT}]`,
      );
    }
    return;
  }
  if (spec === null || typeof spec !== "object") {
    throw new FormatError(`${path}: invalid count spec`);
  }
  requireIntRef(scopes, spec.ref, path);
}

function validateFields(
  fields: Field[],
  scopes: Scope[],
  defs: Record<string, StructDef>,
  path: string,
): void {
  if (!Array.isArray(fields)) {
    throw new FormatError(`${path}: fields must be an array`);
  }
  const local: Scope = new Map();
  const inner = [...scopes, local];
  fields.forEach((field, index) => {
    const p = `${path}.fields[${index}]`;
    if (field === null || typeof field !== "object") {
      throw new FormatError(`${p}: field must be an object`);
    }
    if (typeof field.name !== "string" || field.name === "") {
      throw new FormatError(`${p}: field needs a non-empty name`);
    }
    if (local.has(field.name)) {
      throw new FormatError(`${p}: duplicate field name "${field.name}"`);
    }
    if (field.when !== undefined) {
      validateCondition(field.when, inner, `${p}.when`);
    }
    let kind: RefKind = "other";
    switch (field.type) {
      case "uint8":
      case "uint16le":
      case "uint16be":
      case "uint32le":
      case "uint32be":
        kind = field.when === undefined ? "int" : "other";
        break;
      case "bytes":
      case "string":
        validateLength(field.length, inner, `${p}.length`);
        break;
      case "array":
        validateCount(field.count, inner, `${p}.count`);
        validateElement(field.element, inner, defs, `${p}.element`);
        break;
      case "struct":
        validateFields(field.fields, inner, defs, p);
        break;
      case "ref":
        if (
          typeof field.ref !== "string" ||
          !Object.prototype.hasOwnProperty.call(defs, field.ref)
        ) {
          throw new FormatError(`${p}: unknown definition "${String(field.ref)}"`);
        }
        break;
      default:
        throw new FormatError(
          `${p}: unknown field type "${String((field as { type: unknown }).type)}"`,
        );
    }
    local.set(field.name, kind);
  });
}

function validateElement(
  el: ElementSpec,
  scopes: Scope[],
  defs: Record<string, StructDef>,
  path: string,
): void {
  if (el === null || typeof el !== "object") {
    throw new FormatError(`${path}: element must be an object`);
  }
  switch (el.type) {
    case "uint8":
    case "uint16le":
    case "uint16be":
    case "uint32le":
    case "uint32be":
      return;
    case "bytes":
    case "string":
      validateLength(el.length, scopes, `${path}.length`);
      return;
    case "array":
      validateCount(el.count, scopes, `${path}.count`);
      validateElement(el.element, scopes, defs, `${path}.element`);
      return;
    case "struct":
      validateFields(el.fields, scopes, defs, path);
      return;
    case "ref":
      if (
        typeof el.ref !== "string" ||
        !Object.prototype.hasOwnProperty.call(defs, el.ref)
      ) {
        throw new FormatError(`${path}: unknown definition "${String(el.ref)}"`);
      }
      return;
    default:
      throw new FormatError(`${path}: unknown element type`);
  }
}

function collectRefs(fields: Field[], out: Set<string>): void {
  if (!Array.isArray(fields)) return;
  for (const f of fields) {
    if (f === null || typeof f !== "object") continue;
    if (f.type === "ref") out.add(f.ref);
    else if (f.type === "struct") collectRefs(f.fields, out);
    else if (f.type === "array") collectElementRefs(f.element, out);
  }
}

function collectElementRefs(el: ElementSpec, out: Set<string>): void {
  if (el === null || typeof el !== "object") return;
  if (el.type === "ref") out.add(el.ref);
  else if (el.type === "struct") collectRefs(el.fields, out);
  else if (el.type === "array") collectElementRefs(el.element, out);
}

// Reject cycles in the named-definition graph (e.g. A contains B contains A),
// which would make descriptions infinitely recursive.
function checkDefinitionCycles(defs: Record<string, StructDef>): void {
  const color = new Map<string, number>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (name: string): void => {
    color.set(name, 1);
    stack.push(name);
    const refs = new Set<string>();
    collectRefs(defs[name].fields, refs);
    for (const ref of refs) {
      if (!Object.prototype.hasOwnProperty.call(defs, ref)) continue;
      const c = color.get(ref) ?? 0;
      if (c === 1) {
        throw new FormatError(
          `definition cycle detected: ${[...stack, ref].join(" -> ")}`,
        );
      }
      if (c === 0) visit(ref);
    }
    stack.pop();
    color.set(name, 2);
  };
  for (const name of Object.keys(defs)) {
    if ((color.get(name) ?? 0) === 0) visit(name);
  }
}

export function validateFormat(format: Format): void {
  if (format === null || typeof format !== "object") {
    throw new FormatError("format must be an object");
  }
  const defs = format.definitions ?? {};
  if (defs === null || typeof defs !== "object") {
    throw new FormatError("definitions must be an object");
  }
  for (const [name, def] of Object.entries(defs)) {
    if (def === null || typeof def !== "object" || !Array.isArray(def.fields)) {
      throw new FormatError(
        `definitions.${name}: definition must be an object with a fields array`,
      );
    }
  }
  checkDefinitionCycles(defs);
  for (const [name, def] of Object.entries(defs)) {
    validateFields(def.fields, [], defs, `definitions.${name}`);
  }
  if (typeof format.root === "string") {
    if (!Object.prototype.hasOwnProperty.call(defs, format.root)) {
      throw new FormatError(`root: unknown definition "${format.root}"`);
    }
  } else if (format.root !== null && typeof format.root === "object") {
    validateFields(format.root.fields, [], defs, "root");
  } else {
    throw new FormatError("root must be a struct definition or a definition name");
  }
}
