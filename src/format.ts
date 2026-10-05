/** 格式化定义域上限：9999亿9999万9999.99（分）。 */
export const MAX_CENTS = 99_999_999_999_999n;

/**
 * formatAmount 是 parseAmount 的逆函数（在 [0, MAX_CENTS] 上）：
 *   parseAmount(formatAmount(c)).cents === c
 *   formatAmount(parseAmount(formatAmount(c))) === formatAmount(c)  （规范形幂等）
 * 规范形：非零段才输出；高位段存在时低位非零段零占位补齐 4 位；
 * 小数去掉尾零（0.50 -> .5），无小数不输出点。
 */
export function formatAmount(centsInput: bigint | number): string {
  const cents = BigInt(centsInput);
  if (cents < 0n) throw new RangeError("金额不能为负");
  if (cents > MAX_CENTS) {
    throw new RangeError("超出可格式化范围（最大 9999亿9999万9999.99）");
  }
  const yuan = cents / 100n;
  const frac = Number(cents % 100n);
  const yi = yuan / 100_000_000n;
  const rest = yuan % 100_000_000n;
  const wan = rest / 10_000n;
  const ge = rest % 10_000n;

  let out = "";
  if (yi > 0n) out += `${yi}亿`;
  if (wan > 0n) out += `${yi > 0n ? String(wan).padStart(4, "0") : wan}万`;
  if (ge > 0n) out += out.length > 0 ? String(ge).padStart(4, "0") : `${ge}`;
  if (out === "") out = "0";
  if (frac > 0) {
    out += frac % 10 === 0 ? `.${frac / 10}` : `.${String(frac).padStart(2, "0")}`;
  }
  return out;
}
