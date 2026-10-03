// Dimensions are exponent maps over base dimensions { mass, currency }.
// ppm and bare numbers are dimensionless; g/kg are mass; CNY is currency.

export const DIMLESS = Object.freeze({});

export function dimAdd(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (out[k] || 0) + v;
    if (out[k] === 0) delete out[k];
  }
  return out;
}

export function dimSub(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (out[k] || 0) - v;
    if (out[k] === 0) delete out[k];
  }
  return out;
}

export function dimEqual(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function dimToString(d) {
  const keys = Object.keys(d).sort();
  if (keys.length === 0) return 'dimensionless';
  const num = [];
  const den = [];
  for (const k of keys) {
    const e = d[k];
    if (e > 0) num.push(e === 1 ? k : `${k}^${e}`);
    else den.push(e === -1 ? k : `${k}^${-e}`);
  }
  if (den.length === 0) return num.join('*');
  if (num.length === 0) return `1/${den.join('*')}`;
  return `${num.join('*')}/${den.join('*')}`;
}

export const MASS = Object.freeze({ mass: 1 });
export const CURRENCY = Object.freeze({ currency: 1 });
export const CURRENCY_PER_MASS = Object.freeze({ currency: 1, mass: -1 });
