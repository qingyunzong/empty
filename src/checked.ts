import { ParseError } from "./errors.js";

/** 单项长度/计数及其乘积的上限（2^31 - 1）。 */
export const MAX_LENGTH = 0x7fffffff;

/** 元素大小未知或为 0 时数组计数的上限，防止空转循环。 */
export const MAX_DYNAMIC_ITEMS = 1_000_000;

/** 校验运行时解析出的长度/计数，越界抛 ParseError("overflow")。 */
export function checkLength(value: unknown, at: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ParseError("overflow", at, `${what} must be a non-negative safe integer, got ${String(value)}`);
  }
  if (value > MAX_LENGTH) {
    throw new ParseError("overflow", at, `${what} ${value} exceeds maximum length ${MAX_LENGTH}`);
  }
  return value;
}

/** 防溢出的长度乘法：乘积必须是不超过 MAX_LENGTH 的安全整数。 */
export function checkedMul(a: number, b: number, at: number, what: string): number {
  const product = a * b;
  if (!Number.isSafeInteger(product) || product > MAX_LENGTH) {
    throw new ParseError("overflow", at, `${what} overflow: ${a} * ${b} exceeds maximum ${MAX_LENGTH}`);
  }
  return product;
}

/**
 * 校验数组计数并做长度乘法防溢出检查。
 * 返回元素静态大小已知时的总字节数；元素大小未知或为 0 时返回 -1。
 */
export function checkArray(count: unknown, elemStaticSize: number | null, at: number): number {
  const n = checkLength(count, at, "array count");
  if (elemStaticSize === null || elemStaticSize === 0) {
    if (n > MAX_DYNAMIC_ITEMS) {
      throw new ParseError(
        "overflow",
        at,
        `array count ${n} with variable/zero-size elements exceeds limit ${MAX_DYNAMIC_ITEMS}`
      );
    }
    return -1;
  }
  return checkedMul(n, elemStaticSize, at, "array byte size");
}
