import { createHash } from 'node:crypto';

// Canonical hash used as the deterministic tie-break when two announcements
// for the same security share an ex-date and version.
export function hashParts(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function actionHash(st) {
  const p = st.params;
  const paramStr = st.action.kind === 'split' ? `ratio=${p.ratio}`
    : st.action.kind === 'dividend' ? `amount=${p.amount}`
    : `price=${p.price},fraction=${p.fraction}`;
  return hashParts([st.id, st.sec, st.action.kind, paramStr, st.ex, String(st.version)]);
}

// Compiles checked statements into a flat bytecode op stream.
// Ops: APPLY | RESTATE | REVERSE | SELL.
export function compileOps(stmts) {
  const ops = [];
  for (const st of stmts) {
    if (st.type === 'APPLY') {
      ops.push({
        op: 'APPLY', id: st.id, sec: st.sec, kind: st.action.kind,
        params: st.params, ex: st.ex, version: st.version, hash: actionHash(st),
      });
    } else if (st.type === 'RESTATED') {
      ops.push({
        op: 'RESTATE', id: st.id, sec: st.sec, kind: st.action.kind,
        params: st.params, ex: st.ex, version: st.version, hash: actionHash(st),
      });
    } else if (st.type === 'REVERSE') {
      ops.push({
        op: 'REVERSE', id: st.id, ex: st.ex, version: st.version,
        hash: hashParts(['reverse', st.id, st.ex, String(st.version)]),
      });
    } else if (st.type === 'SELL') {
      ops.push({ op: 'SELL', sec: st.sec, qty: st.params.qty, date: st.date });
    }
  }
  return ops;
}
