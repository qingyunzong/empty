import { Buffer } from "node:buffer";
import { BadReferenceError, ValidationError } from "./errors.js";
import { Heap } from "./heap.js";
import type { Value } from "./values.js";

export const FORMAT = "vm-snapshot/1";

export type EncodedValue =
  | { t: "int"; v: number }
  | { t: "bytes"; v: string }
  | { t: "ref"; id: number };

export interface SnapshotObject {
  id: number;
  fields: Record<string, EncodedValue>;
}

export interface SnapshotDoc {
  format: string;
  objects: SnapshotObject[];
}

function encodeValue(value: Value): EncodedValue {
  switch (value.kind) {
    case "int":
      return { t: "int", v: value.value };
    case "bytes":
      return { t: "bytes", v: Buffer.from(value.value).toString("base64") };
    case "ref":
      return { t: "ref", id: value.id };
  }
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeValue(raw: unknown, where: string): Value {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`${where}: value must be a tagged object`);
  }
  const rec = raw as Record<string, unknown>;
  switch (rec.t) {
    case "int":
      if (typeof rec.v !== "number" || !Number.isSafeInteger(rec.v)) {
        throw new ValidationError(`${where}: invalid int payload`);
      }
      return { kind: "int", value: rec.v };
    case "bytes":
      if (typeof rec.v !== "string" || !BASE64_RE.test(rec.v)) {
        throw new ValidationError(`${where}: invalid base64 payload`);
      }
      return { kind: "bytes", value: new Uint8Array(Buffer.from(rec.v, "base64")) };
    case "ref":
      if (typeof rec.id !== "number" || !Number.isSafeInteger(rec.id) || rec.id < 1) {
        throw new ValidationError(`${where}: invalid reference id`);
      }
      return { kind: "ref", id: rec.id };
    default:
      throw new ValidationError(`${where}: unknown value tag ${String(rec.t)}`);
  }
}

/** 序列化整个堆。对象按 ID 升序、字段按名字排序,输出确定。 */
export function serialize(heap: Heap): SnapshotDoc {
  const objects: SnapshotObject[] = heap.objects().map((obj) => {
    const fields: Record<string, EncodedValue> = {};
    for (const name of [...obj.fields.keys()].sort()) {
      fields[name] = encodeValue(obj.fields.get(name)!);
    }
    return { id: obj.id, fields };
  });
  return { format: FORMAT, objects };
}

export function serializeToString(heap: Heap): string {
  return JSON.stringify(serialize(heap));
}

interface ParsedObject {
  id: number;
  fields: Array<[string, Value]>;
}

/**
 * 整图校验:结构、ID 唯一性、字段值合法性、引用完整性。
 * 任何坏引用都会在此抛出 BadReferenceError,整图被拒绝。
 */
function validateDocument(doc: unknown): ParsedObject[] {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new ValidationError("snapshot must be a plain object");
  }
  const rec = doc as Record<string, unknown>;
  if (rec.format !== FORMAT) {
    throw new ValidationError(`unsupported snapshot format: ${String(rec.format)}`);
  }
  if (!Array.isArray(rec.objects)) {
    throw new ValidationError("snapshot.objects must be an array");
  }
  const ids = new Set<number>();
  const parsed: ParsedObject[] = [];
  for (const [index, rawObj] of rec.objects.entries()) {
    const where = `objects[${index}]`;
    if (typeof rawObj !== "object" || rawObj === null || Array.isArray(rawObj)) {
      throw new ValidationError(`${where}: must be an object`);
    }
    const entry = rawObj as Record<string, unknown>;
    if (typeof entry.id !== "number" || !Number.isSafeInteger(entry.id) || entry.id < 1) {
      throw new ValidationError(`${where}: invalid object id`);
    }
    if (ids.has(entry.id)) {
      throw new ValidationError(`${where}: duplicate object id ${entry.id}`);
    }
    ids.add(entry.id);
    if (typeof entry.fields !== "object" || entry.fields === null || Array.isArray(entry.fields)) {
      throw new ValidationError(`${where}: fields must be an object`);
    }
    const fields: Array<[string, Value]> = [];
    for (const [name, rawValue] of Object.entries(entry.fields)) {
      if (name.length === 0) {
        throw new ValidationError(`${where}: empty field name`);
      }
      fields.push([name, decodeValue(rawValue, `${where}.fields.${name}`)]);
    }
    parsed.push({ id: entry.id, fields });
  }
  for (const obj of parsed) {
    for (const [name, value] of obj.fields) {
      if (value.kind === "ref" && !ids.has(value.id)) {
        throw new BadReferenceError(
          `object ${obj.id} field "${name}" references missing object ${value.id}`
        );
      }
    }
  }
  return parsed;
}

/**
 * 两阶段加载:先为图中所有对象建壳(阶段一),再逐字段连边(阶段二)。
 * 因此前向引用、共享引用与环都能正确还原。
 * 文档在进入阶段一之前已整体校验,加载过程不会中途失败。
 */
export function deserialize(doc: unknown): Heap {
  const parsed = validateDocument(doc);
  const heap = new Heap();
  for (const obj of parsed) {
    heap.allocate(obj.id);
  }
  for (const obj of parsed) {
    for (const [name, value] of obj.fields) {
      heap.setField(obj.id, name, value);
    }
  }
  return heap;
}

export function deserializeFromString(json: string): Heap {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (err) {
    throw new ValidationError(`snapshot is not valid JSON: ${(err as Error).message}`);
  }
  return deserialize(doc);
}
