import type { FieldLabel, ScalarType } from "./types.ts";

export type WireFamily =
  | "varint"
  | "zigzag"
  | "fixed32"
  | "fixed64"
  | "length"
  | "group"
  | "unknown";

export interface ScalarInfo {
  wireType: number;
  family: WireFamily;
  packable: boolean;
}

export const scalarInfo: Record<ScalarType, ScalarInfo> = {
  double: { wireType: 1, family: "fixed64", packable: true },
  float: { wireType: 5, family: "fixed32", packable: true },
  int32: { wireType: 0, family: "varint", packable: true },
  int64: { wireType: 0, family: "varint", packable: true },
  uint32: { wireType: 0, family: "varint", packable: true },
  uint64: { wireType: 0, family: "varint", packable: true },
  sint32: { wireType: 0, family: "zigzag", packable: true },
  sint64: { wireType: 0, family: "zigzag", packable: true },
  fixed32: { wireType: 5, family: "fixed32", packable: true },
  fixed64: { wireType: 1, family: "fixed64", packable: true },
  sfixed32: { wireType: 5, family: "fixed32", packable: true },
  sfixed64: { wireType: 1, family: "fixed64", packable: true },
  bool: { wireType: 0, family: "varint", packable: true },
  string: { wireType: 2, family: "length", packable: false },
  bytes: { wireType: 2, family: "length", packable: false },
};

export const scalarNames = new Set<string>(Object.keys(scalarInfo));

export function isScalarType(value: string): value is ScalarType {
  return scalarNames.has(value);
}

export function wireTypeOfScalar(type: ScalarType): number {
  return scalarInfo[type].wireType;
}

export function wireFamilyOf(field: {
  typeKind: string;
  scalar?: ScalarType;
  wireType: number;
}): WireFamily {
  if (field.typeKind === "scalar" && field.scalar) return scalarInfo[field.scalar].family;
  if (field.typeKind === "enum") return "varint";
  if (field.typeKind === "group" || field.wireType === 3) return "group";
  if (field.typeKind === "map" || field.typeKind === "message" || field.typeKind === "unknown") {
    return "length";
  }
  switch (field.wireType) {
    case 0:
      return "varint";
    case 1:
      return "fixed64";
    case 2:
      return "length";
    case 5:
      return "fixed32";
    default:
      return "unknown";
  }
}

export function isPackable(typeKind: string, scalar?: ScalarType): boolean {
  if (typeKind === "enum") return true;
  if (typeKind === "scalar" && scalar) return scalarInfo[scalar].packable;
  return false;
}

export function wireTypeName(wireType: number): string {
  switch (wireType) {
    case 0:
      return "varint";
    case 1:
      return "fixed64";
    case 2:
      return "length-delimited";
    case 3:
      return "start-group";
    case 4:
      return "end-group";
    case 5:
      return "fixed32";
    default:
      return `wire-type-${wireType}`;
  }
}

export function defaultJsonName(name: string): string {
  let result = "";
  let upperNext = false;
  for (const char of name) {
    if (char === "_") {
      upperNext = true;
      continue;
    }
    result += upperNext ? char.toUpperCase() : char;
    upperNext = false;
  }
  return result;
}

export function normalizeLabel(value: unknown, repeated?: boolean, required?: boolean): FieldLabel {
  if (required) return "required";
  if (repeated) return "repeated";
  const label =
    typeof value === "string"
      ? value.toLowerCase()
      : typeof value === "number"
        ? String(value)
        : "";
  if (label === "repeated" || label === "3") return "repeated";
  if (label === "required" || label === "2") return "required";
  return "optional";
}
