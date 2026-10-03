import { createHash } from 'node:crypto';
import { Fraction } from './fraction.js';
import { CaError } from './errors.js';

export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Static typing of expressions. Types: num (dimensionless), shares, cash.
// Mixing cash and shares (or any incompatible pair) is a compile-time E_TYPE error.
export function evalExpr(node) {
  switch (node.k) {
    case 'lit':
      return { type: node.t, value: Fraction.parse(node.v) };
    case 'neg': {
      const e = evalExpr(node.e);
      return { type: e.type, value: e.value.neg() };
    }
    case 'bin': {
      const l = evalExpr(node.l);
      const r = evalExpr(node.r);
      const bad = () => new CaError('E_TYPE', `type error: cannot apply '${node.op}' to ${l.type} and ${r.type}`);
      if (node.op === '+' || node.op === '-') {
        if (l.type !== r.type) throw bad();
        return { type: l.type, value: node.op === '+' ? l.value.add(r.value) : l.value.sub(r.value) };
      }
      if (node.op === '*') {
        if (l.type === 'num') return { type: r.type, value: l.value.mul(r.value) };
        if (r.type === 'num') return { type: l.type, value: l.value.mul(r.value) };
        throw bad();
      }
      if (r.type === 'num') return { type: l.type, value: l.value.div(r.value) };
      if (l.type === r.type) return { type: 'num', value: l.value.div(r.value) };
      throw bad();
    }
    default:
      throw new CaError('E_PARSE', `unknown expression node '${node.k}'`);
  }
}

const KINDS = new Set(['split', 'dividend', 'tender']);

// Build a validated action definition from parsed fields.
// `base` is the previous definition when restating an existing action.
export function buildAction(id, fields, base = null) {
  const get = (n) => fields.find((f) => f.name === n);
  const has = (n) => fields.some((f) => f.name === n);

  const security = has('security') ? get('security').value : base?.security;
  const kind = has('kind') ? get('kind').value : base?.kind;
  if (!security) throw new CaError('E_ACTION', `action '${id}': missing 'security'`);
  if (!kind || !KINDS.has(kind)) throw new CaError('E_ACTION', `action '${id}': missing or invalid 'kind'`);
  if (base && security !== base.security) throw new CaError('E_ACTION', `restate '${id}': cannot change security`);
  if (base && has('kind') && kind !== base.kind) throw new CaError('E_ACTION', `restate '${id}': cannot change kind`);

  const exdate = has('exdate') ? get('exdate').value : base?.exdate;
  if (!exdate) throw new CaError('E_ACTION', `action '${id}': missing 'exdate'`);
  if (!isValidDate(exdate)) throw new CaError('E_DATE', `action '${id}': invalid exdate '${exdate}'`);

  if (!has('version')) throw new CaError('E_ACTION', `action '${id}': missing 'version'`);
  const version = parseInt(get('version').value, 10);
  if (!(version >= 1)) throw new CaError('E_ACTION', `action '${id}': version must be >= 1`);

  let ratio = base ? base.ratio : null;
  let cash = base ? base.cash : null;
  let cashinlieu = base ? base.cashinlieu : null;

  if (has('ratio')) {
    const e = evalExpr(get('ratio').expr);
    if (e.type !== 'num') throw new CaError('E_RATIO', `action '${id}': ratio must be dimensionless, got ${e.type}`);
    ratio = e.value;
  }
  if (has('cash')) {
    const e = evalExpr(get('cash').expr);
    if (e.type !== 'cash') throw new CaError('E_TYPE', `action '${id}': cash field must be cash-typed, got ${e.type}`);
    cash = e.value;
  }
  if (has('cashinlieu')) {
    const e = evalExpr(get('cashinlieu').expr);
    if (e.type !== 'cash') throw new CaError('E_TYPE', `action '${id}': cashinlieu must be cash-typed, got ${e.type}`);
    cashinlieu = e.value;
  }

  if (kind === 'split') {
    if (!ratio) throw new CaError('E_ACTION', `action '${id}': split requires 'ratio'`);
    // Ratio is old:new. A split issues more shares than before, so 0 < ratio < 1.
    if (ratio.sign() <= 0 || ratio.cmp(new Fraction(1n)) >= 0) {
      throw new CaError('E_RATIO', `action '${id}': split ratio must be in (0,1) old:new, got ${ratio}`);
    }
  }
  if ((kind === 'dividend' || kind === 'tender') && !cash) {
    throw new CaError('E_ACTION', `action '${id}': ${kind} requires 'cash'`);
  }

  const def = { id, security, kind, exdate, version, ratio, cash, cashinlieu };
  def.hash = hashAction(def);
  return def;
}

export function hashAction(def) {
  const canonical = JSON.stringify({
    id: def.id,
    security: def.security,
    kind: def.kind,
    exdate: def.exdate,
    version: def.version,
    ratio: def.ratio ? def.ratio.toString() : null,
    cash: def.cash ? def.cash.toString() : null,
    cashinlieu: def.cashinlieu ? def.cashinlieu.toString() : null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
