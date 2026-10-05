/** 标量值：NULL 用 null 表示。 */
export type Value = null | number | string | boolean;

/** 三值逻辑：FALSE < UNKNOWN < TRUE（AND 取小，OR 取大）。 */
export type Tri = 0 | 1 | 2;
export const FALSE: Tri = 0;
export const UNKNOWN: Tri = 1;
export const TRUE: Tri = 2;

export const triAnd = (a: Tri, b: Tri): Tri => Math.min(a, b) as Tri;
export const triOr = (a: Tri, b: Tri): Tri => Math.max(a, b) as Tri;
export const triNot = (a: Tri): Tri => (2 - a) as Tri;
export const triOf = (b: boolean): Tri => (b ? TRUE : FALSE);

export function triName(t: Tri): string {
  return t === TRUE ? 'TRUE' : t === UNKNOWN ? 'UNKNOWN' : 'FALSE';
}
