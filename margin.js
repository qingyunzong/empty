#!/usr/bin/env node
// Margin freeze ledger with CRDT-style merge, release tombstones and idempotent events.
// Node.js 22, standard library only.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class MarginError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const err = (code, msg) => new MarginError(code, msg);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function createState() {
  return { securities: {}, events: {} };
}

export function setMargin(state, symbol, amount) {
  assertSymbol(symbol);
  assertAmount(amount, true);
  const existing = state.securities[symbol];
  if (existing) {
    if (existing.margin !== amount) throw err('margin-conflict', `margin for ${symbol} already set`);
    return state;
  }
  state.securities[symbol] = { margin: amount };
  return state;
}

function assertSymbol(symbol) {
  if (typeof symbol !== 'string' || symbol.length === 0) throw err('invalid-event', 'symbol must be a non-empty string');
}

function assertAmount(amount, allowZero = false) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw err('invalid-amount', 'amount must be a finite number');
  if (allowZero ? amount < 0 : amount <= 0) throw err('invalid-amount', 'amount must be positive');
}

function validateEvent(event, type) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) throw err('invalid-event', 'event must be an object');
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) throw err('invalid-event', 'eventId required');
  if (typeof event.freezeId !== 'string' || event.freezeId.length === 0) throw err('invalid-event', 'freezeId required');
  assertAmount(event.amount);
  if (type === 'freeze') assertSymbol(event.symbol);
  return { type, eventId: event.eventId, freezeId: event.freezeId, symbol: event.symbol, amount: event.amount };
}

// Replay a single event onto a derived position view. Throws MarginError on constraint violations.
function applyDerived(secs, ev) {
  if (ev.type === 'freeze') {
    const sec = (secs[ev.symbol] ||= { available: 0, frozen: {}, tombstones: {} });
    if (sec.frozen[ev.freezeId] || sec.tombstones[ev.freezeId] !== undefined) {
      throw err('duplicate-freeze', `freezeId ${ev.freezeId} already used`);
    }
    if (sec.available < ev.amount) throw err('insufficient-margin', `insufficient margin for ${ev.symbol}`);
    sec.available -= ev.amount;
    sec.frozen[ev.freezeId] = { amount: ev.amount, released: 0 };
  } else if (ev.type === 'release') {
    for (const sym of Object.keys(secs)) {
      const sec = secs[sym];
      const entry = sec.frozen[ev.freezeId];
      if (entry) {
        if (entry.released + ev.amount > entry.amount) {
          throw err('over-release', `release exceeds frozen amount for ${ev.freezeId}`);
        }
        entry.released += ev.amount;
        sec.available += ev.amount;
        if (entry.released === entry.amount) {
          sec.tombstones[ev.freezeId] = entry.amount;
          delete sec.frozen[ev.freezeId];
        }
        return;
      }
      if (sec.tombstones[ev.freezeId] !== undefined) {
        throw err('over-release', `freeze ${ev.freezeId} fully released; stale release rejected`);
      }
    }
    throw err('unknown-freeze', `unknown freezeId ${ev.freezeId}`);
  } else {
    throw err('invalid-event', `unknown event type ${ev.type}`);
  }
}

// Derive positions by replaying the event log in deterministic (sorted eventId) order.
export function derive(state) {
  const secs = {};
  for (const [sym, s] of Object.entries(state.securities)) {
    secs[sym] = { available: s.margin, frozen: {}, tombstones: {} };
  }
  for (const id of Object.keys(state.events).sort()) {
    applyDerived(secs, state.events[id]);
  }
  return secs;
}

export function applyEvent(state, rawEvent, type) {
  const event = validateEvent(rawEvent, type);
  const existing = state.events[event.eventId];
  if (existing) {
    if (canonical(existing) === canonical(event)) return { state, changed: false };
    throw err('event-conflict', `eventId ${event.eventId} reused with different payload`);
  }
  const next = structuredClone(state);
  next.events[event.eventId] = event;
  derive(next); // validates constraints; throws before mutation is committed
  state.events[event.eventId] = event;
  return { state, changed: true };
}

export function mergeStates(a, b) {
  const merged = structuredClone(a);
  for (const [sym, s] of Object.entries(b.securities)) {
    const cur = merged.securities[sym];
    if (cur) {
      if (cur.margin !== s.margin) throw err('margin-conflict', `conflicting margin for ${sym}`);
    } else {
      merged.securities[sym] = structuredClone(s);
    }
  }
  for (const [id, ev] of Object.entries(b.events)) {
    const cur = merged.events[id];
    if (cur) {
      if (canonical(cur) !== canonical(ev)) throw err('event-conflict', `eventId ${id} differs across replicas`);
    } else {
      merged.events[id] = structuredClone(ev);
    }
  }
  derive(merged); // validate merged history (e.g. combined freezes may exceed margin)
  return merged;
}

export function position(state, symbol) {
  const secs = derive(state);
  const sec = secs[symbol] || { available: 0, frozen: {}, tombstones: {} };
  return {
    symbol,
    available: sec.available,
    frozen: Object.keys(sec.frozen).sort().map((fid) => ({
      freezeId: fid,
      amount: sec.frozen[fid].amount,
      released: sec.frozen[fid].released,
      remaining: sec.frozen[fid].amount - sec.frozen[fid].released,
    })),
    tombstones: Object.keys(sec.tombstones).sort(),
  };
}

export function certificate(state, symbol) {
  const pos = position(state, symbol);
  const secs = derive(state);
  const sec = secs[symbol] || { tombstones: {} };
  const releases = {};
  for (const fid of Object.keys(sec.tombstones).sort()) {
    releases[fid] = sha256(`release:${fid}:${sec.tombstones[fid]}`);
  }
  const releaseHash = sha256(
    Object.keys(releases).sort().map((fid) => `${fid}:${releases[fid]}`).join('|') || 'empty',
  );
  return {
    symbol: pos.symbol,
    available: pos.available,
    frozen: pos.frozen,
    releases,
    releaseHash,
  };
}

// ---------------- CLI ----------------

function readJsonArg(arg) {
  let text;
  if (arg === '-') text = readFileSync(0, 'utf8');
  else if (arg.startsWith('@')) text = readFileSync(arg.slice(1), 'utf8');
  else text = arg;
  try {
    return JSON.parse(text);
  } catch {
    throw err('invalid-json', 'could not parse JSON input');
  }
}

function loadState(file) {
  if (!existsSync(file)) return createState();
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw err('invalid-state', `could not parse state file ${file}`);
  }
}

function saveState(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function run(argv, out) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'init': {
      const [file, symbol, amount] = args;
      if (!file || !symbol || amount === undefined) throw err('usage', 'init <file> <symbol> <amount>');
      const state = loadState(file);
      setMargin(state, symbol, Number(amount));
      saveState(file, state);
      out(position(state, symbol));
      return;
    }
    case 'freeze':
    case 'release': {
      const [file, eventArg] = args;
      if (!file || eventArg === undefined) throw err('usage', `${cmd} <file> <event-json|@file|->`);
      const state = loadState(file);
      const event = readJsonArg(eventArg);
      applyEvent(state, event, cmd);
      saveState(file, state);
      out(cmd === 'freeze' ? position(state, event.symbol) : positionsView(state));
      return;
    }
    case 'merge': {
      const [fileA, fileB, outFile] = args;
      if (!fileA || !fileB) throw err('usage', 'merge <fileA> <fileB> [outFile]');
      const merged = mergeStates(loadState(fileA), loadState(fileB));
      saveState(outFile || fileA, merged);
      out(positionsView(merged));
      return;
    }
    case 'position': {
      const [file, symbol] = args;
      if (!file || !symbol) throw err('usage', 'position <file> <symbol>');
      out(position(loadState(file), symbol));
      return;
    }
    case 'cert': {
      const [file, symbol] = args;
      if (!file || !symbol) throw err('usage', 'cert <file> <symbol>');
      out(certificate(loadState(file), symbol));
      return;
    }
    default:
      throw err('usage', 'commands: init | freeze | release | merge | position | cert');
  }
}

function positionsView(state) {
  const secs = derive(state);
  const result = {};
  for (const sym of Object.keys(secs).sort()) result[sym] = position(state, sym);
  return result;
}

// Runs one CLI invocation. Returns the exit code; all output (incl. errors) goes to `write`.
export function cli(argv, write = (s) => process.stdout.write(s)) {
  const out = (value) => write(JSON.stringify(value) + '\n');
  try {
    run(argv, out);
    return 0;
  } catch (e) {
    if (e instanceof MarginError) {
      out({ error: e.code });
    } else {
      out({ error: 'internal-error' });
      process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
    }
    return 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = cli(process.argv.slice(2));
}
