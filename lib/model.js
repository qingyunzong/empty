'use strict';

class InputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InputError';
    this.code = code || 'E_INPUT';
  }
}

const NATURE = { asset: 1, expense: 1, liability: -1, equity: -1, revenue: -1 };

function natureOf(side) {
  return Object.prototype.hasOwnProperty.call(NATURE, side) ? NATURE[side] : 1;
}

function asArray(value, field) {
  if (!Array.isArray(value)) throw new InputError(`field "${field}" must be an array`);
  return value;
}

function domainValues(domain) {
  if (domain == null) throw new InputError('missing "domain"');
  let values;
  if (Array.isArray(domain.values)) {
    values = domain.values;
  } else {
    const { min, max, step } = domain;
    if (![min, max, step].every(Number.isFinite) || step <= 0 || min > max) {
      throw new InputError('domain requires finite min <= max and step > 0');
    }
    values = [];
    for (let v = min; v <= max + 1e-9; v += step) {
      values.push(Math.round(v * 1e9) / 1e9);
    }
  }
  if (!values.every(Number.isFinite)) throw new InputError('domain values must be finite numbers');
  const nonzero = [...new Set(values.filter((v) => v !== 0))];
  if (!nonzero.length) throw new InputError('domain is empty');
  return nonzero.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
}

function normalizeFormula(raw, itemIds) {
  if (!raw || typeof raw.id !== 'string') throw new InputError('formula requires a string id');
  const side = (terms) =>
    asArray(terms, `formula "${raw.id}" terms`).map((t) => {
      const coef = t.coef == null ? 1 : t.coef;
      if (!Number.isFinite(coef)) throw new InputError(`formula "${raw.id}" has invalid coef`);
      if (t.const != null) {
        if (!Number.isFinite(t.const)) throw new InputError(`formula "${raw.id}" has invalid const`);
        return { kind: 'const', value: t.const, coef };
      }
      if (t.item != null) {
        if (!itemIds.has(t.item)) {
          throw new InputError(`formula "${raw.id}" references unknown item "${t.item}"`);
        }
        return { kind: 'item', item: t.item, coef };
      }
      if (t.side != null) return { kind: 'side', side: t.side, coef };
      throw new InputError(`formula "${raw.id}" has an invalid term`);
    });
  return { id: raw.id, lhs: side(raw.lhs), rhs: side(raw.rhs) };
}

function normalize(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('input must be a JSON object');
  }

  const items = asArray(raw.items, 'items').map((it) => {
    if (!it || typeof it.id !== 'string') throw new InputError('item requires a string id');
    return { id: it.id, side: it.side || 'asset', restatement: it.restatement === true };
  });
  const itemIds = new Set(items.map((i) => i.id));
  if (itemIds.size !== items.length) throw new InputError('duplicate item id');

  const periods = asArray(raw.periods, 'periods').map((p) => {
    if (!p || typeof p.id !== 'string') throw new InputError('period requires a string id');
    const status = p.status || 'open';
    if (status !== 'open' && status !== 'closed') {
      throw new InputError(`invalid period status "${status}"`, 'E_PERIOD');
    }
    return { id: p.id, status };
  });
  const periodIds = new Set(periods.map((p) => p.id));
  if (periodIds.size !== periods.length) throw new InputError('duplicate period id');

  const balances = {};
  for (const it of items) {
    balances[it.id] = {};
    for (const p of periods) balances[it.id][p.id] = 0;
  }
  for (const [itemId, per] of Object.entries(raw.balances || {})) {
    if (!itemIds.has(itemId)) throw new InputError(`balances reference unknown item "${itemId}"`);
    for (const [pid, val] of Object.entries(per || {})) {
      if (!periodIds.has(pid)) {
        throw new InputError(`balances reference unknown period "${pid}"`, 'E_PERIOD');
      }
      if (!Number.isFinite(val)) throw new InputError('balance must be a finite number');
      balances[itemId][pid] = val;
    }
  }

  const formulas = asArray(raw.formulas, 'formulas').map((f) => normalizeFormula(f, itemIds));
  const formulaIds = new Set(formulas.map((f) => f.id));
  if (formulaIds.size !== formulas.length) throw new InputError('duplicate formula id');

  const check = raw.check == null ? formulas.map((f) => f.id) : asArray(raw.check, 'check').slice();
  for (const id of check) {
    if (!formulaIds.has(id)) throw new InputError(`unknown formula "${id}"`, 'E_FORMULA');
  }

  const layers = asArray(raw.layers == null ? [{ id: 'L1' }] : raw.layers, 'layers').map((l) => {
    if (!l || typeof l.id !== 'string') throw new InputError('layer requires a string id');
    const publish = l.publish || 'ok';
    if (publish !== 'ok' && publish !== 'fail') {
      throw new InputError(`invalid layer publish mode "${publish}"`);
    }
    return { id: l.id, publish };
  });
  const layerIds = new Set(layers.map((l) => l.id));
  if (layerIds.size !== layers.length) throw new InputError('duplicate layer id');

  const vouchers = asArray(
    raw.vouchers == null ? [{ id: 'V1', layer: layers[0].id }] : raw.vouchers,
    'vouchers'
  ).map((v) => {
    if (!v || typeof v.id !== 'string') throw new InputError('voucher requires a string id');
    const layer = v.layer || layers[0].id;
    if (!layerIds.has(layer)) {
      throw new InputError(`voucher "${v.id}" references unknown layer "${layer}"`);
    }
    return { id: v.id, layer, required: v.required === true };
  });

  const budget = raw.budget == null ? 100000 : raw.budget;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new InputError('budget must be a non-negative integer');
  }

  return {
    items,
    periods,
    balances,
    domain: domainValues(raw.domain),
    formulas,
    check,
    layers,
    vouchers,
    budget,
  };
}

function applyEntries(model, entries) {
  const bal = {};
  for (const [item, per] of Object.entries(model.balances)) bal[item] = { ...per };
  for (const e of entries) bal[e.item][e.period] += e.amount;
  return bal;
}

function termValue(term, model, bal, periodId) {
  if (term.kind === 'const') return term.value * term.coef;
  if (term.kind === 'item') return term.coef * bal[term.item][periodId];
  return (
    term.coef *
    model.items
      .filter((i) => i.side === term.side)
      .reduce((s, i) => s + bal[i.id][periodId], 0)
  );
}

function formulaResidual(model, formula, bal, periodId) {
  const sum = (terms) => terms.reduce((a, t) => a + termValue(t, model, bal, periodId), 0);
  return sum(formula.lhs) - sum(formula.rhs);
}

function evaluateAll(model, entries, formulaIds) {
  const bal = applyEntries(model, entries);
  const out = [];
  for (const f of model.formulas) {
    if (formulaIds && !formulaIds.includes(f.id)) continue;
    for (const p of model.periods) {
      out.push({ formula: f.id, period: p.id, residual: formulaResidual(model, f, bal, p.id) });
    }
  }
  return out;
}

module.exports = {
  InputError,
  natureOf,
  normalize,
  applyEntries,
  formulaResidual,
  evaluateAll,
};
