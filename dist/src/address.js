export function parseAddr(text) {
    const m = /^([A-Z]+)([0-9]+)$/.exec(text);
    if (!m)
        throw new Error(`invalid cell address: ${text}`);
    let col = 0;
    for (const ch of m[1])
        col = col * 26 + (ch.charCodeAt(0) - 64);
    const row = Number.parseInt(m[2], 10);
    if (row < 1)
        throw new Error(`invalid cell address (row < 1): ${text}`);
    return { col: col - 1, row };
}
export function formatAddr(addr) {
    let c = addr.col + 1;
    let s = '';
    while (c > 0) {
        s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
        c = Math.floor((c - 1) / 26);
    }
    return s + String(addr.row);
}
/** Row-major order: row first, then column. Returns negative/0/positive. */
export function compareAddr(a, b) {
    return a.row - b.row || a.col - b.col;
}
