export type JsonObject = {
    [key: string]: JsonValue;
};
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export declare function isPlainObject(value: unknown): value is JsonObject;
export declare function deepEqual(a: unknown, b: unknown): boolean;
export declare function clone<T extends JsonValue>(value: T): T;
/** Canonical JSON: object keys sorted recursively, so digest is structure-stable. */
export declare function canonicalize(value: unknown): string;
/** sha256 hex digest of the canonical form of a JSON value. */
export declare function digest(value: unknown): string;
export declare function getAtPath(doc: JsonValue, path: string[]): JsonValue | undefined;
export declare function pathKey(path: string[]): string;
export declare function formatPath(path: string[]): string;
