/** 单元格地址，0 基。 */
export interface Addr {
  col: number;
  row: number;
}

/** 解析 "A1"、"bc12" 形式的地址；非法返回 null。 */
export function parseAddr(text: string): Addr | null {
  const m = /^([A-Za-z]{1,3})([0-9]{1,7})$/.exec(text);
  if (!m) return null;
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

export function formatAddr(addr: Addr): string {
  let c = addr.col + 1;
  let s = '';
  while (c > 0) {
    s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s + String(addr.row + 1);
}

/** 规范化地址字符串（统一大小写），非法地址抛错。 */
export function normAddr(text: string): string {
  const addr = parseAddr(text);
  if (!addr) throw new Error(`invalid cell address: ${text}`);
  return formatAddr(addr);
}

/**
 * 地址全序：行优先（行号小者优先），同行列号小者优先。
 * 即 A1 < B1 < A2。错误传播取“最小来源地址”时使用该序。
 */
export function compareAddr(a: Addr, b: Addr): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

export function compareAddrStr(a: string, b: string): number {
  const pa = parseAddr(a);
  const pb = parseAddr(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  return compareAddr(pa, pb);
}
