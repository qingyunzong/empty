/**
 * Values that can be canonically encoded.
 *
 * - integers: `number` (must be a safe integer) or `bigint` (64-bit range)
 * - byte strings: `Uint8Array` (incl. `Buffer`)
 * - arrays: plain JS arrays of values
 * - objects: plain objects or `Map<string, CanonicalValue>`; keys are strings
 */
export type CanonicalValue =
  | number
  | bigint
  | Uint8Array
  | readonly CanonicalValue[]
  | CanonicalObject;

export type CanonicalObject =
  | { readonly [key: string]: CanonicalValue }
  | ReadonlyMap<string, CanonicalValue>;
