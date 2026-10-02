import { Frac } from './fraction.js';
import { Ledger } from './engine.js';
import { LedgerError } from './events.js';
import { computePotentials } from './rates.js';

function fracFromString(text) {
  if (typeof text !== 'string' || !/^-?\d+(\/\d+)?$/.test(text)) return null;
  const [n, d] = text.split('/');
  return new Frac(BigInt(n), d === undefined ? 1n : BigInt(d));
}

export function verifyCertificate(eventsText, cert) {
  const checks = [];
  const record = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const fail = (name, detail) => {
    record(name, false, detail);
    return { valid: false, checks };
  };

  const ledger = new Ledger();
  const lines = String(eventsText).split(/\r?\n/);
  let lineNo = 0;
  try {
    for (const raw of lines) {
      lineNo += 1;
      if (!raw.trim()) continue;
      ledger.applyLine(raw, lineNo);
    }
  } catch (e) {
    if (e instanceof LedgerError) return fail('events-parse', `${e.code}: ${e.message}`);
    throw e;
  }
  record('events-parse', true, `${ledger.stats().events} events`);

  if (
    cert === null ||
    typeof cert !== 'object' ||
    cert.type !== 'RATE_CYCLE_CONFLICT' ||
    !Array.isArray(cert.steps) ||
    cert.steps.length < 2 ||
    typeof cert.product !== 'string'
  ) {
    return fail('certificate-shape', 'not a RATE_CYCLE_CONFLICT certificate');
  }
  record('certificate-shape', true, `${cert.steps.length} steps`);

  let stepsValid = true;
  const edges = [];
  for (const step of cert.steps) {
    const rec = ledger.getEvent(step.eventId);
    const slot = rec && rec.type === 'setRate' ? rec.slot : null;
    const active = !!rec && rec.voidCount === 0;
    const pair = slot ? `${slot.from}/${slot.to}` : null;
    const rateOk = slot && slot.current.toString() === step.rate;
    const ok = !!slot && active && pair === step.pair && rateOk;
    if (!ok) stepsValid = false;
    record(
      `step:${step.eventId}`,
      ok,
      ok
        ? `${step.pair} = ${step.rate} (${step.direction})`
        : `missing, voided, or mismatched rate event ${JSON.stringify(step.eventId)}`
    );
    if (slot) edges.push({ eid: slot.eid, from: slot.from, to: slot.to, rate: slot.current });
  }
  if (!stepsValid) return { valid: false, checks };

  const seq = [];
  for (const step of cert.steps) {
    const [f, t] = step.pair.split('/');
    seq.push(step.direction === 'forward' ? [f, t] : [t, f]);
  }
  let simple = true;
  for (let i = 0; i < seq.length; i += 1) {
    if (seq[i][1] !== seq[(i + 1) % seq.length][0]) simple = false;
  }
  const cycleNodes = seq.map(([u]) => u);
  if (new Set(cycleNodes).size !== cycleNodes.length) simple = false;
  if (!record('simple-cycle', simple, simple ? cycleNodes.join(' -> ') : 'steps do not form a simple cycle')) {
    return { valid: false, checks };
  }

  let product = Frac.one();
  for (const step of cert.steps) {
    const rate = fracFromString(step.rate);
    if (rate === null || rate.sign() <= 0) return fail('product', `bad rate literal: ${step.rate}`);
    product = step.direction === 'forward' ? product.mul(rate) : product.div(rate);
  }
  record('product-matches', product.toString() === cert.product, `recomputed ${product}`);
  record('product-not-one', !product.eq(Frac.one()), `cycle product = ${product}`);

  let minimal = true;
  for (let i = 0; i < edges.length; i += 1) {
    const rest = edges.filter((_, j) => j !== i);
    const seed = rest.length > 0 ? rest[0].from : cert.base ?? 'BASE';
    const { conflict } = computePotentials(seed, rest);
    if (conflict !== null) {
      minimal = false;
      record(`minimal:without-${edges[i].eid}`, false, 'still infeasible without this step');
    }
  }
  if (minimal) record('minimal', true, 'removing any single step restores consistency');

  if (typeof cert.historyHash === 'string') {
    const actual = ledger.historyHash();
    record('history-hash', actual === cert.historyHash, `ledger hash ${actual}`);
  }

  return { valid: checks.every((c) => c.ok), checks };
}
