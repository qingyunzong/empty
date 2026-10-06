export interface IntValue {
  readonly kind: "int";
  readonly value: number;
}

export interface BytesValue {
  readonly kind: "bytes";
  readonly value: Uint8Array;
}

export interface RefValue {
  readonly kind: "ref";
  readonly id: number;
}

export type Value = IntValue | BytesValue | RefValue;

export function int(value: number): IntValue {
  return { kind: "int", value };
}

export function bytes(value: Uint8Array): BytesValue {
  return { kind: "bytes", value };
}

export function ref(id: number): RefValue {
  return { kind: "ref", id };
}

export function isObjectId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

/** Returns null when the value is well-formed, otherwise a reason string. */
export function validateValue(
  value: Value,
  hasObject: (id: number) => boolean,
): string | null {
  if (value === null || typeof value !== "object") {
    return "value must be a tagged value object";
  }
  switch (value.kind) {
    case "int":
      if (!Number.isSafeInteger(value.value)) {
        return `int field requires a safe integer, got ${String(value.value)}`;
      }
      return null;
    case "bytes":
      if (!(value.value instanceof Uint8Array)) {
        return "bytes field requires a Uint8Array";
      }
      return null;
    case "ref":
      if (!isObjectId(value.id)) {
        return `ref field requires a positive integer object id, got ${String(value.id)}`;
      }
      if (!hasObject(value.id)) {
        return `ref field points to missing object #${value.id}`;
      }
      return null;
    default:
      return `unknown value kind ${String((value as { kind: unknown }).kind)}`;
  }
}
