import type { BinaryLike } from "./binary.ts";

export interface CaptureColumnInput {
  name?: string;
  column_name?: string;
  ordinal?: number;
  column_ordinal?: number;
  type?: string;
  column_type?: string;
  nullable?: boolean;
  is_nullable?: boolean;
  [key: string]: unknown;
}

export type CaptureColumnLike = string | CaptureColumnInput;

export interface CaptureSchemaInput {
  captureInstance?: string;
  capture_instance?: string;
  name?: string;
  instance?: string;
  table?: string;
  columns?: readonly CaptureColumnLike[];
  [key: string]: unknown;
}

export type CaptureSchemaLike =
  | CaptureSchemaInput
  | readonly CaptureColumnLike[];

export interface CaptureColumn {
  /** 1-based ordinal used by `sys.fn_cdc_get_column_ordinal`. */
  ordinal: number;
  name: string;
  type?: string;
  nullable?: boolean;
  source?: CaptureColumnInput;
  [key: string]: unknown;
}

export interface CaptureInstanceSchema {
  captureInstance: string;
  columns: readonly CaptureColumn[];
  source?: CaptureSchemaInput;
  [key: string]: unknown;
}

export const DEFAULT_CAPTURE_INSTANCE = "default";

/**
 * Normalize the many shapes a capture-instance schema can arrive in.
 *
 * SQL catalog rows commonly use `column_name` / `column_ordinal`; hand-written
 * schemas usually use `name` / `ordinal`.  A bare array of names is accepted
 * as well, in which case ordinals are assigned by position.
 */
export function normalizeSchema(
  schema: CaptureSchemaLike,
  captureInstance?: string,
): CaptureInstanceSchema {
  let input: CaptureSchemaInput;
  let columnsInput: readonly CaptureColumnLike[];

  if (Array.isArray(schema)) {
    input = { columns: schema };
    columnsInput = schema as readonly CaptureColumnLike[];
  } else {
    input = schema as CaptureSchemaInput;
    columnsInput = input.columns ?? [];
  }

  if (!Array.isArray(columnsInput) || columnsInput.length === 0) {
    throw new TypeError("Capture instance schema must define at least one column");
  }

  const instance =
    captureInstance ??
    input.captureInstance ??
    input.capture_instance ??
    input.name ??
    input.instance ??
    input.table ??
    DEFAULT_CAPTURE_INSTANCE;

  const seenOrdinals = new Map<number, string>();
  const seenNames = new Set<string>();
  const columns: CaptureColumn[] = columnsInput.map((column, index) => {
    if (typeof column === "string") {
      if (column.length === 0) {
        throw new TypeError(`Empty column name at position ${index + 1}`);
      }
      if (seenNames.has(column)) {
        throw new TypeError(`Duplicate column name: ${column}`);
      }
      seenNames.add(column);
      return { ordinal: index + 1, name: column };
    }

    const name = column.name ?? column.column_name;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`Missing column name at position ${index + 1}`);
    }
    const rawOrdinal = column.ordinal ?? column.column_ordinal ?? index + 1;
    const ordinal = typeof rawOrdinal === "number" ? rawOrdinal : Number(rawOrdinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new TypeError(`Invalid ordinal for column ${name}: ${String(ordinal)}`);
    }
    if (seenOrdinals.has(ordinal)) {
      throw new TypeError(
        `Duplicate column ordinal ${ordinal}: ${seenOrdinals.get(ordinal)} and ${name}`,
      );
    }
    if (seenNames.has(name)) {
      throw new TypeError(`Duplicate column name: ${name}`);
    }
    seenOrdinals.set(ordinal, name);
    seenNames.add(name);
    return {
      ordinal,
      name,
      type: column.type ?? column.column_type,
      nullable:
        column.nullable ??
        (column.is_nullable === undefined ? undefined : Boolean(column.is_nullable)),
      source: column,
    };
  });

  columns.sort((left, right) => left.ordinal - right.ordinal);
  const highestOrdinal = columns[columns.length - 1].ordinal;
  if (highestOrdinal > 4096) {
    throw new RangeError("Capture instance schema has an unreasonable ordinal");
  }

  return {
    captureInstance: instance,
    columns,
    source: input,
  };
}

export function schemaColumnNames(schema: CaptureInstanceSchema): string[] {
  return schema.columns.map((column) => column.name);
}

export function findColumn(
  schema: CaptureInstanceSchema,
  nameOrOrdinal: string | number,
): CaptureColumn | undefined {
  if (typeof nameOrOrdinal === "number") {
    return schema.columns.find((column) => column.ordinal === nameOrOrdinal);
  }
  return schema.columns.find((column) => column.name === nameOrOrdinal);
}

export type LsnValue = BinaryLike;
