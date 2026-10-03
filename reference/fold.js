// Independent reference fold used by the randomized differential test.
// Unlike the VM (incremental deltas + bytecode), this recomputes the whole
// state from the accepted-event list on every event, evaluating expressions
// by tree-walking the AST. No VM code is shared.
import { parseLine } from '../src/parser.js';
import { checkEvent } from '../src/check.js';
import { contentHash } from '../src/compile.js';
import { evalAst, SCALE, formatScaled } from '../src/expr.js';
import { DslError, E_NEG, E_SEQ, E_SIGN, E_VERSION } from '../src/errors.js';

function freezeOfRec(rec) {
  const price = evalAst(rec.priceExpr, {});
  const env = { qty: rec.qty * SCALE, price, accrued: rec.accrued };
  const fee = rec.feeExpr ? evalAst(rec.feeExpr, env) : 0n;
  if (fee < 0n) throw new DslError(E_SIGN, 'negative fee');
  const gross = rec.cls === 'bond' ? price + rec.accrued : price;
  return rec.dir === 'buy'
    ? { qty: 0n, cash: rec.qty * gross + fee }
    : { qty: rec.qty, cash: 0n };
}

function effectiveRec(graph) {
  let best = null;
  for (const [ver, recs] of graph.versions) {
    if (graph.tombstones.has(ver) || recs.length === 0) continue;
    const cand = recs.reduce((a, b) => (a.hash <= b.hash ? a : b));
    if (!best || ver > best.version) best = { version: ver, rec: cand };
  }
  return best;
}

// Full re-fold of an accepted-event list into cells + scopes.
function fullFold(accepted) {
  const scopes = new Map();
  const cells = new Map(); // key -> {heldQty, heldCash, frozenQty, frozenCash}
  const cellOf = (key) => {
    let c = cells.get(key);
    if (!c) { c = { heldQty: 0n, heldCash: 0n, frozenQty: 0n, frozenCash: 0n }; cells.set(key, c); }
    return c;
  };
  for (const ev of accepted) {
    if (ev.kind === 'deposit') {
      const c = cellOf(`${ev.date}|${ev.isin}`);
      c.heldQty += ev.qty;
      c.heldCash += ev.cash;
      continue;
    }
    let scope = scopes.get(ev.date);
    if (!scope) { scope = new Map(); scopes.set(ev.date, scope); }
    if (ev.kind === 'trade') {
      scope.set(ev.id, { dir: ev.dir, isin: ev.isin,
        versions: new Map([[1, [ev]]]), tombstones: new Set() });
    } else if (ev.kind === 'amend') {
      const g = scope.get(ev.id);
      const recs = g.versions.get(ev.version) ?? [];
      g.versions.set(ev.version, [...recs, ev]);
    } else if (ev.kind === 'cancel') {
      scope.get(ev.id).tombstones.add(ev.version);
    }
  }
  for (const [date, scope] of scopes) {
    for (const g of scope.values()) {
      cellOf(`${date}|${g.isin}`); // cell exists even for zero delta
      const eff = effectiveRec(g);
      if (!eff) continue;
      const f = freezeOfRec(eff.rec);
      const c = cellOf(`${date}|${g.isin}`);
      c.frozenQty += f.qty;
      c.frozenCash += f.cash;
    }
  }
  return { scopes, cells };
}

function checkConstraints(cells) {
  for (const c of cells.values()) {
    if (c.frozenQty < 0n || c.frozenCash < 0n) return false;
    if (c.frozenQty > c.heldQty || c.frozenCash > c.heldCash) return false;
  }
  return true;
}

// Static + scope validation for one candidate against the accepted history.
function validate(ev, accepted) {
  const { cls } = checkEvent(ev); // E_SIGN for static type errors
  if (ev.kind === 'deposit' || ev.kind === 'cancel-pending-ok') return { cls };
  const { scopes } = fullFold(accepted);
  const scope = scopes.get(ev.date);
  if (ev.kind === 'trade') {
    if (ev.version !== 1) throw new DslError(E_VERSION, 'trade must start at v1');
    if (scope?.has(ev.id)) throw new DslError(E_VERSION, `duplicate trade ${ev.id}`);
  } else if (ev.kind === 'amend') {
    const g = scope?.get(ev.id);
    if (!g) throw new DslError(E_VERSION, `unknown trade ${ev.id} in scope ${ev.date}`);
    if (ev.version < 2) throw new DslError(E_VERSION, 'amend version must be >= 2');
    if (ev.dir !== g.dir) throw new DslError(E_SIGN, 'amend cannot flip direction');
    if (ev.isin !== g.isin) throw new DslError(E_SIGN, 'amend cannot change instrument');
  } else if (ev.kind === 'cancel') {
    if (!scope?.has(ev.id)) throw new DslError(E_VERSION, `unknown trade ${ev.id}`);
  }
  return { cls };
}

export class ReferenceFolder {
  constructor() {
    this.accepted = [];
    this.seen = new Map();
    this.lastSeq = 0;
    this.rejected = []; // [{seq, code}]
  }

  // Returns {ok, noop} or records a rejection; never throws for DSL errors.
  push(seq, text) {
    let ev;
    try {
      ev = parseLine(text, 1);
      if (!ev) return { ok: true, noop: true };
      ev.hash = contentHash(ev);
      ev.cls = null;
      const prior = this.seen.get(seq);
      if (prior !== undefined) {
        if (prior === ev.hash) return { ok: true, noop: true };
        throw new DslError(E_SEQ, `conflicting event for seq ${seq}`);
      }
      if (seq < this.lastSeq) throw new DslError(E_SEQ, 'seq goes backwards');
      const { cls } = validate(ev, this.accepted);
      ev.cls = cls ?? ev.cls;
      if (ev.kind !== 'deposit') {
        const trial = fullFold([...this.accepted, ev]);
        if (!checkConstraints(trial.cells)) throw new DslError(E_NEG, 'freeze out of bounds');
      }
      this.accepted.push(ev);
      this.seen.set(seq, ev.hash);
      this.lastSeq = seq;
      return { ok: true, noop: false };
    } catch (err) {
      if (err instanceof DslError) {
        this.rejected.push({ seq, code: err.code });
        return { ok: false, code: err.code };
      }
      throw err;
    }
  }

  state() {
    const { scopes, cells } = fullFold(this.accepted);
    const ledger = {};
    for (const [key, c] of [...cells.entries()].sort()) {
      ledger[key] = {
        heldQty: c.heldQty.toString(),
        frozenQty: c.frozenQty.toString(),
        heldCash: formatScaled(c.heldCash),
        frozenCash: formatScaled(c.frozenCash),
      };
    }
    const outScopes = {};
    for (const [date, scope] of [...scopes.entries()].sort()) {
      const trades = {};
      for (const [id, g] of [...scope.entries()].sort()) {
        const eff = effectiveRec(g);
        trades[id] = {
          direction: g.dir,
          effective: eff ? { version: eff.version, hash: eff.rec.hash.slice(0, 12) } : null,
          versions: [...g.versions.keys()].sort((a, b) => a - b),
          tombstones: [...g.tombstones].sort((a, b) => a - b),
        };
      }
      outScopes[date] = trades;
    }
    return { lastSeq: this.lastSeq, ledger, scopes: outScopes };
  }
}
