/** Cell address. Ordering is row-major: compare row first, then column. */
export interface Addr {
  col: number; // 0-based (A = 0)
  row: number; // 1-based (row 1 = first row)
}

export function parseAddr(text: string): Addr {
  const m = /^([A-Z]+)([0-9]+)$/.exec(text);
  if (!m) throw new Error(`invalid cell address: ${text}`);
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number.parseInt(m[2]!, 10);
  if (row < 1) throw new Error(`invalid cell address (row < 1): ${text}`);
  return { col: col - 1, row };
}

export function formatAddr(addr: Addr): string {
  let c = addr.col + 1;
  let s = '';
  while (c > 0) {
    s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s + String(addr.row);
}

/** Row-major order: row first, then column. Returns negative/0/positive. */
export function compareAddr(a: Addr, b: Addr): number {
  return a.row - b.row || a.col - b.col;
}
