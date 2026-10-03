import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BusinessError,
  applyCommand,
  decodeTicket,
  execute,
  genesis,
  loadState,
  remaining,
  ticketStatus,
} from '../src/store.js';
import { verifyChain } from '../src/chunklog.js';

const LIMIT = 150;
const AMOUNT = 100;
const MAX_DEPTH = 12;

// Independent reference model of the ticket state machine.
function modelGenesis() {
  return { tickets: [] };
}
function mRemaining(t) {
  return t.amount - t.captured - t.released;
}
function mTargetIndex(m) {
  for (let i = m.tickets.length - 1; i >= 0; i -= 1) {
    const t = m.tickets[i];
    if (!t.closed && mRemaining(t) > 0) return i;
  }
  return m.tickets.length - 1;
}
function modelApply(m, op) {
  switch (op.name) {
    case 'freeze': {
      const total = m.tickets.reduce((s, t) => s + mRemaining(t), 0);
      if (total + AMOUNT > LIMIT) return 'insufficient total credit';
      m.tickets.push({ amount: AMOUNT, captured: 0, released: 0, closed: null });
      return null;
    }
    case 'capture40': case 'capture100': case 'capture999': {
      const amt = { capture40: 40, capture100: 100, capture999: 999 }[op.name];
      const t = m.tickets[mTargetIndex(m)];
      if (!t || t.closed || mRemaining(t) === 0) return 'not open';
      if (amt > mRemaining(t)) return 'capture exceeds';
      t.captured += amt;
      return null;
    }
    case 'release30': case 'release999': {
      const amt = { release30: 30, release999: 999 }[op.name];
      const t = m.tickets[mTargetIndex(m)];
      if (!t || t.closed || mRemaining(t) === 0) return 'not open';
      if (amt > mRemaining(t)) return 'release exceeds';
      t.released += amt;
      return null;
    }
    case 'expire': {
      const t = m.tickets[mTargetIndex(m)];
      if (!t || t.closed || mRemaining(t) === 0) return 'not open';
      t.released += mRemaining(t);
      t.closed = 'expired';
      return null;
    }
    case 'cancel': {
      const t = m.tickets[mTargetIndex(m)];
      if (!t || t.closed || mRemaining(t) === 0) return 'not open';
      t.closed = t.captured === 0 ? 'cancelled' : 'compensated';
      t.released += mRemaining(t);
      return null;
    }
    default:
      throw new Error(`bad op ${op.name}`);
  }
}

const OPS = [
  { name: 'freeze' },
  { name: 'capture40' },
  { name: 'capture100' },
  { name: 'capture999' },
  { name: 'release30' },
  { name: 'release999' },
  { name: 'expire' },
  { name: 'cancel' },
];

function cloneModel(m) {
  return { tickets: m.tickets.map((t) => ({ ...t })) };
}

function cloneState(s) {
  const tickets = {};
  for (const [k, v] of Object.entries(s.tickets)) tickets[k] = { ...v };
  const idempotency = {};
  for (const [k, v] of Object.entries(s.idempotency)) {
    idempotency[k] = { command: v.command, args: { ...v.args }, result: { ...v.result } };
  }
  return { ...s, tickets, idempotency };
}

function ticketIdOf(index) {
  return `T-${String(index + 1).padStart(6, '0')}`;
}

// Ticket ids are issued sequentially, so the model's target index maps
// directly onto the real ticket id.
function realCommandOf(op, model, key) {
  const ticket = ticketIdOf(Math.max(0, mTargetIndex(model)));
  switch (op.name) {
    case 'freeze': return ['freeze', { amount: AMOUNT, key }];
    case 'capture40': return ['capture', { ticket, amount: 40, key }];
    case 'capture100': return ['capture', { ticket, amount: 100, key }];
    case 'capture999': return ['capture', { ticket, amount: 999, key }];
    case 'release30': return ['release', { ticket, amount: 30, key }];
    case 'release999': return ['release', { ticket, amount: 999, key }];
    case 'expire': return ['expire', { ticket, key }];
    case 'cancel': return ['cancel', { ticket, key }];
    default: throw new Error(`bad op ${op.name}`);
  }
}

function compareTickets(realTickets, model, ctx) {
  assert.equal(realTickets.length, model.tickets.length, `${ctx}: ticket count`);
  for (let i = 0; i < model.tickets.length; i += 1) {
    const mt = model.tickets[i];
    const rt = realTickets[i];
    assert.equal(rt.id, ticketIdOf(i), `${ctx}: ticket ${i} id`);
    assert.equal(rt.amount, mt.amount, `${ctx}: ticket ${i} amount`);
    assert.equal(rt.captured, mt.captured, `${ctx}: ticket ${i} captured`);
    assert.equal(rt.released, mt.released, `${ctx}: ticket ${i} released`);
    assert.equal(rt.closed, mt.closed, `${ctx}: ticket ${i} closed`);
    assert.equal(ticketStatus(rt), ticketStatus(mt), `${ctx}: ticket ${i} status`);
  }
}

test('exhaustive ticket state machine enumeration (<=12 ops) matches reference model', () => {
  const seen = new Set([JSON.stringify(modelGenesis())]);
  const queue = [{ model: modelGenesis(), state: genesis(), depth: 0 }];
  let keySeq = 0;
  let edges = 0;
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.depth >= MAX_DEPTH) continue;
    for (const op of OPS) {
      const m2 = cloneModel(node.model);
      const mErr = modelApply(m2, op);
      const ctx = `depth ${node.depth} op ${op.name}`;
      const [command, args] = realCommandOf(op, node.model, `sm-${++keySeq}`);
      if (mErr) {
        // Rejections must not mutate state, so no clone is needed here.
        assert.throws(() => applyCommand(node.state, command, args, LIMIT), BusinessError, ctx);
        edges += 1;
        continue;
      }
      const sig = JSON.stringify(m2);
      if (seen.has(sig)) continue; // transition already verified
      seen.add(sig);
      const s2 = cloneState(node.state);
      applyCommand(s2, command, args, LIMIT);
      compareTickets(Object.values(s2.tickets), m2, ctx);
      edges += 1;
      queue.push({ model: m2, state: s2, depth: node.depth + 1 });
    }
  }
  console.log(`enumerated ${seen.size} distinct states, ${edges} verified transitions, depth <= ${MAX_DEPTH}`);
  assert.ok(seen.size > 1000, 'enumeration should cover a non-trivial state space');
});

// Deterministic PRNG so sampled log-level sequences are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('sampled 12-op sequences through the on-disk chunked log match the model', () => {
  const rand = mulberry32(20261003);
  const SEQUENCES = 40;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fzsm-disk-'));
  try {
    for (let s = 0; s < SEQUENCES; s += 1) {
      const dir = path.join(root, `seq${s}`);
      fs.mkdirSync(dir);
      const model = modelGenesis();
      for (let step = 0; step < MAX_DEPTH; step += 1) {
        const op = OPS[Math.floor(rand() * OPS.length)];
        const ctx = `seq ${s} step ${step} op ${op.name}`;
        const [command, args] = realCommandOf(op, model, `d-${s}-${step}`);
        const mErr = modelApply(model, op);
        if (mErr) {
          const before = verifyChain(dir).tip;
          assert.throws(() => execute(dir, command, args, { fsync: false, creditLimit: LIMIT }), BusinessError, ctx);
          assert.deepEqual(verifyChain(dir).tip, before, `${ctx}: log mutated on rejection`);
          continue;
        }
        execute(dir, command, args, { fsync: false, creditLimit: LIMIT });
      }
      const { state } = loadState(dir);
      const tickets = Object.values(state.tickets);
      compareTickets(tickets, model, `seq ${s} final`);
      // Incremental decode from each ticket's index chunk + preceding snapshot
      // must agree with the full reduction.
      for (const t of tickets) {
        const dec = decodeTicket(dir, t.id).ticket;
        assert.equal(dec.captured, t.captured, `seq ${s} decode ${t.id} captured`);
        assert.equal(dec.released, t.released, `seq ${s} decode ${t.id} released`);
        assert.equal(dec.closed, t.closed, `seq ${s} decode ${t.id} closed`);
        assert.equal(dec.status, ticketStatus(t), `seq ${s} decode ${t.id} status`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
