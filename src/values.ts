import { ValidationError } from "./errors.js";

/** 堆中字段可持有的值:整数、字节串、对象引用。 */
export type Value =
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "ref"; readonly id: number };

export function intValue(value: number): Value {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`not a safe integer: ${value}`);
  }
  return { kind: "int", value };
}

export function bytesValue(data: Uint8Array): Value {
  if (!(data instanceof Uint8Array)) {
    throw new ValidationError("bytes value must be a Uint8Array");
  }
  return { kind: "bytes", value: new Uint8Array(data) };
}

export function refValue(id: number): Value {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ValidationError(`invalid object id: ${id}`);
  }
  return { kind: "ref", id };
}

export function valueEquals(a: Value, b: Value): boolean {
  if (a.kind === "int" && b.kind === "int") return a.value === b.value;
  if (a.kind === "ref" && b.kind === "ref") return a.id === b.id;
  if (a.kind === "bytes" && b.kind === "bytes") {
    return (
      a.value.length === b.value.length &&
      a.value.every((byte, index) => byte === b.value[index])
    );
  }
  return false;
}
