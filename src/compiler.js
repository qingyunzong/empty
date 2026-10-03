import { buildAction, evalExpr, isValidDate } from './types.js';
import { CaError } from './errors.js';

// Compile the program AST to serializable bytecode instructions.
// Consecutive apply statements form a batch; within a batch, applies are
// ordered by (security, ex-date, announcement version, content hash).
export function compile(program) {
  const actions = new Map(); // id -> { def, status }
  const instructions = [];
  let applyBatch = [];

  const flush = () => {
    if (applyBatch.length) {
      applyBatch.sort((a, b) => compareActions(a.action, b.action));
      instructions.push(...applyBatch);
      applyBatch = [];
    }
  };

  for (const stmt of program.body) {
    if (stmt.k !== 'apply') flush();
    switch (stmt.k) {
      case 'action': {
        if (actions.has(stmt.id)) throw new CaError('E_ACTION', `duplicate action '${stmt.id}'`);
        const def = buildAction(stmt.id, stmt.fields);
        actions.set(stmt.id, { def, status: 'declared' });
        break;
      }
      case 'apply': {
        const rec = actions.get(stmt.id);
        if (!rec) throw new CaError('E_ACTION', `apply of unknown action '${stmt.id}'`);
        if (rec.status !== 'declared') {
          throw new CaError('E_REVERSE', `action '${stmt.id}' already applied; use restate to issue a new version`);
        }
        rec.status = 'applied';
        applyBatch.push({ op: 'APPLY', action: encodeAction(rec.def) });
        break;
      }
      case 'reverse': {
        const rec = actions.get(stmt.id);
        if (!rec) throw new CaError('E_ACTION', `reverse of unknown action '${stmt.id}'`);
        if (rec.status !== 'applied') {
          throw new CaError('E_REVERSE', `cannot reverse action '${stmt.id}' in state '${rec.status}'`);
        }
        rec.status = 'reversed';
        instructions.push({ op: 'REVERSE', id: stmt.id });
        break;
      }
      case 'restate': {
        const rec = actions.get(stmt.id);
        if (!rec) throw new CaError('E_ACTION', `restate of unknown action '${stmt.id}'`);
        if (rec.status === 'declared') {
          throw new CaError('E_REVERSE', `cannot restate action '${stmt.id}' before it is applied`);
        }
        const def = buildAction(stmt.id, stmt.fields, rec.def);
        if (def.version <= rec.def.version) {
          throw new CaError('E_REVERSE', `restate '${stmt.id}': version must increase (${rec.def.version} -> ${def.version})`);
        }
        if (def.exdate < rec.def.exdate) {
          throw new CaError('E_DATE', `restate '${stmt.id}': exdate cannot move earlier (${rec.def.exdate} -> ${def.exdate})`);
        }
        rec.def = def;
        rec.status = 'applied';
        instructions.push({ op: 'RESTATE', id: stmt.id, action: encodeAction(def) });
        break;
      }
      case 'sell': {
        const q = evalExpr(stmt.qty);
        if (q.type !== 'num' && q.type !== 'shares') {
          throw new CaError('E_TYPE', `sell quantity must be shares or dimensionless, got ${q.type}`);
        }
        if (q.value.sign() <= 0) throw new CaError('E_LOT', `sell quantity must be positive, got ${q.value}`);
        if (!isValidDate(stmt.date)) throw new CaError('E_DATE', `invalid sell date '${stmt.date}'`);
        instructions.push({ op: 'SELL', security: stmt.security, qty: q.value.toString(), date: stmt.date });
        break;
      }
      default:
        throw new CaError('E_PARSE', `unknown statement kind '${stmt.k}'`);
    }
  }
  flush();
  return { instructions, actions: [...actions.values()].map((r) => encodeAction(r.def)) };
}

function compareActions(a, b) {
  if (a.security !== b.security) return a.security < b.security ? -1 : 1;
  if (a.exdate !== b.exdate) return a.exdate < b.exdate ? -1 : 1;
  if (a.version !== b.version) return a.version - b.version;
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  return 0;
}

function encodeAction(def) {
  return {
    id: def.id,
    security: def.security,
    kind: def.kind,
    exdate: def.exdate,
    version: def.version,
    ratio: def.ratio ? def.ratio.toString() : null,
    cash: def.cash ? def.cash.toString() : null,
    cashinlieu: def.cashinlieu ? def.cashinlieu.toString() : null,
    hash: def.hash,
  };
}
