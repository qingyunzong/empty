import fs from 'node:fs';
import path from 'node:path';
import {
  ZERO_HASH,
  appendChunk,
  chunkFileName,
  chunksDir,
  listChunks,
  verifyChain,
} from './chunklog.js';

export const SNAP_EVERY = 4;
export const DEFAULT_CREDIT_LIMIT = 1_000_000;

export class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
    this.exitCode = 1;
  }
}

export class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptionError';
    this.exitCode = 2;
  }
}

export function genesis() {
  return {
    lastSeq: 0,
    tipHash: ZERO_HASH,
    serialCounter: 0,
    tickets: {},
    idempotency: {},
  };
}

export function remaining(ticket) {
  return ticket.amount - ticket.captured - ticket.released;
}

export function isOpen(ticket) {
  return !ticket.closed && remaining(ticket) > 0;
}

export function ticketStatus(ticket) {
  if (ticket.closed) return ticket.closed;
  const rem = remaining(ticket);
  if (rem === 0) {
    if (ticket.captured === ticket.amount) return 'captured';
    if (ticket.captured === 0) return 'released';
    return 'settled';
  }
  if (ticket.captured > 0) return 'partially_captured';
  if (ticket.released > 0) return 'partially_released';
  return 'open';
}

function applyToTicket(ticket, ev) {
  switch (ev.type) {
    case 'freeze':
      return { id: ev.ticketId, serial: ev.serial, amount: ev.amount, captured: 0, released: 0, closed: null };
    case 'capture':
      ticket.captured += ev.amount;
      return ticket;
    case 'release':
      ticket.released += ev.amount;
      return ticket;
    case 'expire':
      ticket.released += ev.amount;
      ticket.closed = 'expired';
      return ticket;
    case 'cancel':
      ticket.released += ev.amount;
      ticket.closed = 'cancelled';
      return ticket;
    case 'compensate':
      ticket.released += ev.amount;
      ticket.closed = 'compensated';
      return ticket;
    default:
      throw new Error(`unknown event type ${ev.type}`);
  }
}

function resultOf(state, ev) {
  const t = state.tickets[ev.ticketId];
  switch (ev.type) {
    case 'freeze':
      return { ticketId: ev.ticketId, serial: ev.serial, amount: ev.amount, remaining: ev.amount };
    case 'capture':
      return { ticketId: ev.ticketId, amount: ev.amount, captured: t.captured, remaining: remaining(t) };
    case 'release':
      return { ticketId: ev.ticketId, amount: ev.amount, released: t.released, remaining: remaining(t) };
    case 'expire':
      return { ticketId: ev.ticketId, released: ev.amount, status: 'expired' };
    case 'cancel':
      return { ticketId: ev.ticketId, released: ev.amount, status: 'cancelled' };
    case 'compensate':
      return { ticketId: ev.ticketId, released: ev.amount, captured: t.captured, status: 'compensated' };
    default:
      throw new Error(`unknown event type ${ev.type}`);
  }
}

export function applyEvent(state, ev) {
  if (ev.type === 'freeze') {
    state.serialCounter += 1;
    state.tickets[ev.ticketId] = applyToTicket(undefined, ev);
  } else {
    const t = state.tickets[ev.ticketId];
    if (!t) throw new Error(`event references unknown ticket ${ev.ticketId}`);
    applyToTicket(t, ev);
  }
  const result = resultOf(state, ev);
  if (ev.key) {
    state.idempotency[ev.key] = { command: ev.command, args: ev.args, result };
  }
  return result;
}

function snapshotsDir(dir) {
  return path.join(dir, 'snapshots');
}

function listSnapshots(dir) {
  const sdir = snapshotsDir(dir);
  if (!fs.existsSync(sdir)) return [];
  return fs.readdirSync(sdir)
    .map((file) => {
      const m = /^snap-(\d{6,})\.json$/.exec(file);
      return m ? { file, seqEnd: Number(m[1]), path: path.join(sdir, file) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.seqEnd - b.seqEnd);
}

function indexPath(dir) {
  return path.join(dir, 'index.json');
}

export function readIndex(dir) {
  const p = indexPath(dir);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeIndex(dir, index, fsync) {
  const p = indexPath(dir);
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(index));
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeSnapshot(dir, state, fsync) {
  const sdir = snapshotsDir(dir);
  fs.mkdirSync(sdir, { recursive: true });
  const file = `snap-${String(state.lastSeq).padStart(6, '0')}.json`;
  const p = path.join(sdir, file);
  const fd = fs.openSync(p, 'w');
  try {
    fs.writeSync(fd, JSON.stringify({ seqEnd: state.lastSeq, state }));
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function loadState(dir) {
  const chain = verifyChain(dir);
  if (!chain.ok) {
    throw new CorruptionError(`chunk ${chain.bad.file}: ${chain.bad.reason}`);
  }
  const tip = chain.tip;
  const snaps = listSnapshots(dir).filter((s) => s.seqEnd <= tip.seqEnd);
  let state;
  let fromSeq;
  if (snaps.length > 0) {
    const snap = snaps[snaps.length - 1];
    state = JSON.parse(fs.readFileSync(snap.path, 'utf8')).state;
    fromSeq = snap.seqEnd;
  } else {
    state = genesis();
    fromSeq = 0;
  }
  for (const chunk of chain.chunks) {
    if (chunk.seqEnd <= fromSeq) continue;
    for (const ev of chunk.events) applyEvent(state, ev);
  }
  state.lastSeq = tip.seqEnd;
  state.tipHash = tip.hash;
  return { state, chain };
}

export function decodeTicket(dir, ticketId) {
  const chain = verifyChain(dir);
  if (!chain.ok) {
    throw new CorruptionError(`chunk ${chain.bad.file}: ${chain.bad.reason}`);
  }
  const index = readIndex(dir);
  const chunkFile = index[ticketId];
  if (!chunkFile) throw new BusinessError(`unknown ticket ${ticketId}`);
  const entry = chain.chunks.find((c) => c.file === chunkFile);
  if (!entry) throw new CorruptionError(`index chunk ${chunkFile} missing from log`);
  const snaps = listSnapshots(dir).filter((s) => s.seqEnd < entry.seqStart);
  let ticket;
  let fromSeq = 0;
  if (snaps.length > 0) {
    const snap = snaps[snaps.length - 1];
    const snapState = JSON.parse(fs.readFileSync(snap.path, 'utf8')).state;
    ticket = snapState.tickets[ticketId];
    fromSeq = snap.seqEnd;
  }
  for (const chunk of chain.chunks) {
    if (chunk.seqEnd <= fromSeq) continue;
    for (const ev of chunk.events) {
      if (ev.ticketId === ticketId) ticket = applyToTicket(ticket, ev);
    }
  }
  if (!ticket) throw new BusinessError(`unknown ticket ${ticketId}`);
  return {
    ticket: { ...ticket, remaining: remaining(ticket), status: ticketStatus(ticket) },
    indexChunk: chunkFile,
    snapshotSeq: fromSeq,
  };
}

function totalFrozen(state) {
  let total = 0;
  for (const t of Object.values(state.tickets)) total += remaining(t);
  return total;
}

function requireTicket(state, ticketId) {
  const t = state.tickets[ticketId];
  if (!t) throw new BusinessError(`unknown ticket ${ticketId}`);
  return t;
}

function requireOpen(state, ticketId, action) {
  const t = requireTicket(state, ticketId);
  if (!isOpen(t)) throw new BusinessError(`cannot ${action}: ticket ${ticketId} is ${ticketStatus(t)}`);
  return t;
}

function assertAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BusinessError(`amount must be a positive integer, got ${amount}`);
  }
}

function buildEvents(state, command, args, creditLimit) {
  switch (command) {
    case 'freeze': {
      assertAmount(args.amount);
      if (totalFrozen(state) + args.amount > creditLimit) {
        throw new BusinessError('insufficient total credit');
      }
      const n = state.serialCounter + 1;
      const ticketId = `T-${String(n).padStart(6, '0')}`;
      const serial = `FZ-${String(n).padStart(6, '0')}`;
      return [{ type: 'freeze', command, key: args.key, args: { amount: args.amount }, ticketId, serial, amount: args.amount }];
    }
    case 'capture': {
      assertAmount(args.amount);
      const t = requireOpen(state, args.ticket, 'capture');
      if (args.amount > remaining(t)) {
        throw new BusinessError(`capture exceeds remaining frozen (${remaining(t)})`);
      }
      return [{ type: 'capture', command, key: args.key, args: { ticket: args.ticket, amount: args.amount }, ticketId: args.ticket, amount: args.amount }];
    }
    case 'release': {
      assertAmount(args.amount);
      const t = requireOpen(state, args.ticket, 'release');
      if (args.amount > remaining(t)) {
        throw new BusinessError(`release exceeds remaining frozen (${remaining(t)})`);
      }
      return [{ type: 'release', command, key: args.key, args: { ticket: args.ticket, amount: args.amount }, ticketId: args.ticket, amount: args.amount }];
    }
    case 'expire': {
      const t = requireOpen(state, args.ticket, 'expire');
      return [{ type: 'expire', command, key: args.key, args: { ticket: args.ticket }, ticketId: args.ticket, amount: remaining(t) }];
    }
    case 'cancel': {
      const t = requireTicket(state, args.ticket);
      if (t.closed || remaining(t) === 0) {
        throw new BusinessError(`cannot cancel: ticket ${args.ticket} is ${ticketStatus(t)}`);
      }
      if (t.captured === 0) {
        return [{ type: 'cancel', command, key: args.key, args: { ticket: args.ticket }, ticketId: args.ticket, amount: remaining(t) }];
      }
      return [{ type: 'compensate', command, key: args.key, args: { ticket: args.ticket }, ticketId: args.ticket, amount: remaining(t), captured: t.captured }];
    }
    default:
      throw new BusinessError(`unknown command ${command}`);
  }
}

function sameArgs(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function businessArgsOf(command, args) {
  if (command === 'freeze') return { amount: args.amount };
  if (command === 'capture' || command === 'release') return { ticket: args.ticket, amount: args.amount };
  return { ticket: args.ticket };
}

function planCommand(state, command, args, creditLimit) {
  if (args.key && state.idempotency[args.key]) {
    const rec = state.idempotency[args.key];
    const businessArgs = businessArgsOf(command, args);
    if (rec.command !== command || !sameArgs(rec.args, businessArgs)) {
      throw new BusinessError(`idempotency key ${args.key} reused with different command or arguments`);
    }
    return { replay: rec.result };
  }
  return { events: buildEvents(state, command, args, creditLimit) };
}

export function applyCommand(state, command, args, creditLimit = DEFAULT_CREDIT_LIMIT) {
  const plan = planCommand(state, command, args, creditLimit);
  if (plan.replay) return { result: plan.replay, replayed: true, events: [] };
  let result;
  for (const ev of plan.events) result = applyEvent(state, ev);
  return { result, replayed: false, events: plan.events };
}

export function execute(dir, command, args, opts = {}) {
  const fsyncOpt = opts.fsync !== false;
  const creditLimit = opts.creditLimit ?? DEFAULT_CREDIT_LIMIT;
  const { state } = loadState(dir);
  const plan = planCommand(state, command, args, creditLimit);
  if (plan.replay) return { result: plan.replay, replayed: true, state };
  const events = plan.events;
  const tip = { seqEnd: state.lastSeq, hash: state.tipHash };
  const chunk = appendChunk(dir, tip, events, { fsync: fsyncOpt });
  let result;
  for (const ev of events) result = applyEvent(state, ev);
  state.lastSeq = chunk.seqEnd;
  state.tipHash = chunk.hash;
  const freezeEvents = events.filter((ev) => ev.type === 'freeze');
  if (freezeEvents.length > 0) {
    const index = readIndex(dir);
    for (const ev of freezeEvents) {
      if (!index[ev.ticketId]) index[ev.ticketId] = chunk.file;
    }
    writeIndex(dir, index, fsyncOpt);
  }
  if (chunk.ordinal % SNAP_EVERY === 0) writeSnapshot(dir, state, fsyncOpt);
  return { result, replayed: false, state };
}

export function recover(dir) {
  const chain = verifyChain(dir);
  const removedChunks = [];
  if (!chain.ok) {
    const cdir = chunksDir(dir);
    const all = listChunks(dir);
    const cut = all.findIndex((c) => c.ordinal === chain.bad.ordinal);
    for (const c of all.slice(cut)) {
      fs.unlinkSync(c.path);
      removedChunks.push(c.file);
    }
    for (const file of fs.readdirSync(cdir)) {
      if (!/^chunk-\d{6,}\.chk$/.test(file)) {
        fs.unlinkSync(path.join(cdir, file));
        removedChunks.push(file);
      }
    }
  }
  const tip = chain.tip;
  const removedSnapshots = [];
  for (const snap of listSnapshots(dir)) {
    if (snap.seqEnd > tip.seqEnd) {
      fs.unlinkSync(snap.path);
      removedSnapshots.push(snap.file);
    }
  }
  const index = {};
  for (const chunk of chain.ok ? chain.chunks : chain.valid) {
    for (const ev of chunk.events) {
      if (ev.type === 'freeze' && !index[ev.ticketId]) index[ev.ticketId] = chunk.file;
    }
  }
  writeIndex(dir, index, true);
  return {
    healthy: chain.ok,
    removedChunks,
    removedSnapshots,
    confirmedSeqEnd: tip.seqEnd,
    tipHash: tip.hash,
    indexedTickets: Object.keys(index).length,
  };
}
