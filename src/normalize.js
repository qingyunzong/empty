import { fail } from './errors.js';

// Cell tags: N = NULL (encoded as \N in CSV), U = unknown (? or NaN),
// F = float (canonical shortest round-trip), S = string.
export function validateTolerance(tol) {
  const abs = tol?.abs ?? 0;
  const rel = tol?.rel ?? 0;
  for (const [name, value] of [['abs', abs], ['rel', rel]]) {
    if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value < 0) {
      fail('E_TOL', `invalid tolerance ${name}=${value}`);
    }
  }
  return { abs, rel };
}

export function canonicalFloat(n) {
  if (Object.is(n, -0)) return '0';
  return String(n);
}

export function typeCell(raw) {
  if (raw === '\\N') return { t: 'N' };
  if (raw === '?' || raw === 'NaN') return { t: 'U' };
  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isNaN(n) && Number.isFinite(n)) return { t: 'F', v: n };
  }
  return { t: 'S', v: raw };
}

export function encodeCell(cell) {
  switch (cell.t) {
    case 'N': return 'N';
    case 'U': return 'U';
    case 'F': return 'F' + canonicalFloat(cell.v);
    default: return 'S' + cell.v;
  }
}

export function decodeCell(enc) {
  const tag = enc[0];
  if (tag === 'N') return { t: 'N' };
  if (tag === 'U') return { t: 'U' };
  if (tag === 'F') return { t: 'F', v: Number(enc.slice(1)) };
  return { t: 'S', v: enc.slice(1) };
}

export function displayCell(enc) {
  const c = decodeCell(enc);
  if (c.t === 'N') return null;
  if (c.t === 'U') return '<unknown>';
  return c.v;
}

// Returns 'equal' | 'different' | 'undecided'.
// Unknown values never count as inconsistent: they yield 'undecided'.
export function compareCells(encA, encB, tol) {
  if (encA === encB) return 'equal';
  const a = decodeCell(encA);
  const b = decodeCell(encB);
  if (a.t === 'U' || b.t === 'U') return 'undecided';
  if (a.t === 'F' && b.t === 'F') {
    const d = Math.abs(a.v - b.v);
    const bound = Math.max(tol.abs, tol.rel * Math.max(Math.abs(a.v), Math.abs(b.v)));
    return d <= bound ? 'equal' : 'different';
  }
  return 'different';
}
