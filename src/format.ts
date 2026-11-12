import type { CounterStyle } from "./types.js";

export function formatCounterValue(value: bigint, style: CounterStyle): string {
  if (style === "decimal") {
    return value.toString(10);
  }

  if (value <= 0n) {
    return value.toString(10);
  }

  let remaining = value;
  const digits: string[] = [];
  while (remaining > 0n) {
    remaining -= 1n;
    digits.push(String.fromCharCode(97 + Number(remaining % 26n)));
    remaining /= 26n;
  }
  return digits.reverse().join("");
}
